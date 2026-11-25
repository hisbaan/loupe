//! Self-review: a problem-finding pass over a pull request, private to the
//! user who runs it. Findings are pinned to lines; the user's decisions and
//! their own comments live in `notes_json`, which the web client owns. Export
//! to markdown happens in the browser.

mod output;
mod prompt;

use std::convert::Infallible;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::sse::{Event, Sse},
    routing::{get, put},
};
use futures_util::Stream;
use loupe_protocol::self_review::{SELF_REVIEW_SCHEMA_VERSION, SelfReview};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    job::{self, Effort},
    tools,
};
use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    github,
    inference::Credential,
    pulls,
    source::Source,
    state::AppState,
};

/// Above this, tools are disabled: every tool round resends the whole input.
const MAX_TOOL_INPUT_CHARS: usize = 150_000;
const MAX_NOTES_BYTES: usize = 256 * 1024;
const MAX_LISTED: i64 = 20;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/repos/{owner}/{repo}/pulls/{number}/self-reviews",
            get(list).post(create),
        )
        .route("/self-reviews/{id}/notes", put(save_notes))
}

#[derive(Serialize)]
struct SelfReviewRecord {
    id: i64,
    model: String,
    base_sha: String,
    head_sha: String,
    created_at: i64,
    effort: String,
    /// Repository files the model read.
    files_read: Vec<String>,
    /// Covers the pull request's current base and head commits.
    current: bool,
    review: SelfReview,
    notes: Value,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: i64,
    model: String,
    base_sha: String,
    head_sha: String,
    created_at: i64,
    effort: String,
    files_read: String,
    review_json: String,
    notes_json: String,
}

impl Row {
    fn into_record(self, pr: &pulls::PullResponse) -> AppResult<SelfReviewRecord> {
        Ok(SelfReviewRecord {
            id: self.id,
            model: self.model,
            current: self.base_sha == pr.pull.base.sha && self.head_sha == pr.pull.head.sha,
            base_sha: self.base_sha,
            head_sha: self.head_sha,
            created_at: self.created_at,
            effort: self.effort,
            files_read: serde_json::from_str(&self.files_read).unwrap_or_default(),
            review: serde_json::from_str(&self.review_json).map_err(anyhow::Error::from)?,
            notes: serde_json::from_str(&self.notes_json).unwrap_or_else(|_| Value::Object(Default::default())),
        })
    }
}

/// A macro so queries can `concat!` onto it and stay `&'static str`.
macro_rules! select {
    () => {
        "SELECT id, model, base_sha, head_sha, created_at, effort, files_read, review_json, notes_json FROM self_reviews "
    };
}

#[derive(Serialize)]
struct List {
    /// Newest first.
    self_reviews: Vec<SelfReviewRecord>,
}

/// Your self-reviews of this pull request. Refetching the pull request with
/// your token checks you can still see it.
async fn list(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
) -> AppResult<Json<List>> {
    let token = github::user_token(&state, user.id).await?;
    let pr = pulls::fetch_pull(&state, &token, &owner, &repo, number).await?;
    let rows: Vec<Row> = sqlx::query_as(concat!(
        select!(),
        "WHERE user_id = ? AND repo_id = ? AND pr_number = ? AND prompt_version = ? AND schema_version = ?
         ORDER BY created_at DESC, id DESC LIMIT ?"
    ))
    .bind(user.id)
    .bind(pr.pull.repo_id()?)
    .bind(number as i64)
    .bind(prompt::PROMPT_VERSION)
    .bind(SELF_REVIEW_SCHEMA_VERSION as i64)
    .bind(MAX_LISTED)
    .fetch_all(&state.db)
    .await?;
    let self_reviews = rows.into_iter().map(|r| r.into_record(&pr)).collect::<AppResult<_>>()?;
    Ok(Json(List { self_reviews }))
}

#[derive(Deserialize)]
struct Create {
    credential: Credential,
    model: String,
    #[serde(default)]
    effort: Effort,
}

async fn create(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
    Json(body): Json<Create>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let model = body.model.trim().to_owned();
    if model.is_empty() || model.len() > 100 {
        return Err(AppError::BadRequest("choose a model".into()));
    }
    Ok(job::stream(move |reporter| async move {
        run(
            &state,
            &user,
            &owner,
            &repo,
            number,
            &model,
            body.effort,
            &body.credential,
            &reporter,
        )
        .await
    }))
}

#[allow(clippy::too_many_arguments)]
async fn run(
    state: &AppState,
    user: &CurrentUser,
    owner: &str,
    repo: &str,
    number: u64,
    model: &str,
    effort: Effort,
    credential: &Credential,
    reporter: &job::Reporter,
) -> Result<SelfReviewRecord, String> {
    let err = job::user_error;
    reporter.status("Fetching pull request").await;
    let token = github::user_token(state, user.id).await.map_err(err)?;
    let pr = pulls::fetch_pull(state, &token, owner, repo, number)
        .await
        .map_err(err)?;
    let repo_id = pr.pull.repo_id().map_err(err)?;

    let prompt = prompt::build(&pr).map_err(|chars| {
        format!(
            "This pull request is too large for a self-review ({chars} characters of diff, limit {}).",
            prompt::MAX_INPUT_CHARS
        )
    })?;
    if pr.files.iter().all(|f| f.analysis.hunks.iter().all(|h| h.collapsible)) {
        return Err("Nothing to review: every change was collapsed by the pre-pass.".into());
    }

    let use_tools = prompt.input.len() <= MAX_TOOL_INPUT_CHARS;
    let mut instructions = prompt::INSTRUCTIONS.to_owned();
    let toolbox = if use_tools {
        instructions.push_str(&super::prompt::tool_instructions(effort.budget().calls));
        Some(tools::Toolbox::new(
            Source::new(state.clone(), token, &pr).map_err(err)?,
            effort.budget(),
        ))
    } else {
        None
    };
    let output = job::Generation {
        state,
        credential,
        model,
        effort,
        reporter,
        instructions: &instructions,
        tag: &prompt.tag,
        input: &prompt.input,
        schema_name: output::SCHEMA_NAME,
        schema: output::schema(),
        toolbox,
    }
    .run()
    .await?;
    let review = output::parse(&output.text, &pr).map_err(|e| format!("The model's self-review was invalid: {e}"))?;

    reporter.status("Saving").await;
    let review_json = serde_json::to_string(&review).map_err(|e| err(AppError::Internal(e.into())))?;
    let row: Row = sqlx::query_as(
        "INSERT INTO self_reviews (user_id, repo_id, pr_number, base_sha, head_sha, model, prompt_version,
                                   schema_version, review_json, effort, files_read)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id, model, base_sha, head_sha, created_at, effort, files_read, review_json, notes_json",
    )
    .bind(user.id)
    .bind(repo_id)
    .bind(number as i64)
    .bind(&pr.pull.base.sha)
    .bind(&pr.pull.head.sha)
    .bind(model)
    .bind(prompt::PROMPT_VERSION)
    .bind(SELF_REVIEW_SCHEMA_VERSION as i64)
    .bind(&review_json)
    .bind(effort.as_str())
    .bind(serde_json::to_string(&output.files_read).unwrap_or_else(|_| "[]".into()))
    .fetch_one(&state.db)
    .await
    .map_err(|e| err(e.into()))?;
    row.into_record(&pr).map_err(err)
}

#[derive(Deserialize)]
struct Notes {
    notes: Value,
}

/// Replaces your decisions and comments on one of your self-reviews.
async fn save_notes(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Notes>,
) -> AppResult<StatusCode> {
    if !body.notes.is_object() {
        return Err(AppError::BadRequest("notes must be an object".into()));
    }
    let json = body.notes.to_string();
    if json.len() > MAX_NOTES_BYTES {
        return Err(AppError::BadRequest("too many notes".into()));
    }
    let updated =
        sqlx::query("UPDATE self_reviews SET notes_json = ?, updated_at = unixepoch() WHERE id = ? AND user_id = ?")
            .bind(json)
            .bind(id)
            .bind(user.id)
            .execute(&state.db)
            .await?
            .rows_affected();
    match updated {
        1 => Ok(StatusCode::NO_CONTENT),
        _ => Err(AppError::NotFound),
    }
}

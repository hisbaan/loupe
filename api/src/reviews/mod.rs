//! Guided reviews: generation (streamed over SSE) and the shared cache.

mod output;
mod prompt;
mod tools;

use std::{convert::Infallible, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, State},
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
};
use futures_util::Stream;
use loupe_protocol::review::{GuidedReview, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_stream::{StreamExt, wrappers::ReceiverStream};

use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    github,
    inference::{self, Credential},
    pulls::{self, Author},
    source::Source,
    state::AppState,
};

/// Model turns per review, including the final answer.
const MAX_TURNS: usize = 10;

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/repos/{owner}/{repo}/pulls/{number}/reviews",
        get(list_reviews).post(create_review),
    )
}

#[derive(Serialize)]
pub struct ReviewRecord {
    id: i64,
    model: String,
    prompt_version: i64,
    base_sha: String,
    head_sha: String,
    created_at: i64,
    requested_by: Author,
    review: GuidedReview,
}

#[derive(sqlx::FromRow)]
struct ReviewRow {
    id: i64,
    model: String,
    prompt_version: i64,
    base_sha: String,
    head_sha: String,
    created_at: i64,
    login: String,
    avatar_url: Option<String>,
    review_json: String,
}

impl ReviewRow {
    fn into_record(self) -> AppResult<ReviewRecord> {
        Ok(ReviewRecord {
            id: self.id,
            model: self.model,
            prompt_version: self.prompt_version,
            base_sha: self.base_sha,
            head_sha: self.head_sha,
            created_at: self.created_at,
            requested_by: Author {
                login: self.login,
                avatar_url: self.avatar_url,
            },
            review: serde_json::from_str(&self.review_json).map_err(anyhow::Error::from)?,
        })
    }
}

/// A macro so queries can `concat!` onto it and stay `&'static str`.
macro_rules! select_review {
    () => {
        "SELECT r.id, r.model, r.prompt_version, r.base_sha, r.head_sha, r.created_at,
            u.login, u.avatar_url, r.review_json
         FROM reviews r JOIN users u ON u.id = r.requested_by "
    };
}

#[derive(Serialize)]
struct ReviewList {
    reviews: Vec<ReviewRecord>,
}

/// Cached reviews for the pull request's current base and head. Fetching the
/// pull request with the user's own token is the access check.
async fn list_reviews(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
) -> AppResult<Json<ReviewList>> {
    let token = github::user_token(&state, user.id).await?;
    let pr = pulls::fetch_pull(&state, &token, &owner, &repo, number).await?;

    let rows: Vec<ReviewRow> = sqlx::query_as(concat!(
        select_review!(),
        "WHERE r.repo_id = ? AND r.pr_number = ? AND r.base_sha = ? AND r.head_sha = ?
            AND r.prompt_version = ? AND r.schema_version = ?
         ORDER BY r.created_at DESC"
    ))
    .bind(pr.pull.repo_id()?)
    .bind(number as i64)
    .bind(&pr.pull.base.sha)
    .bind(&pr.pull.head.sha)
    .bind(prompt::PROMPT_VERSION)
    .bind(SCHEMA_VERSION as i64)
    .fetch_all(&state.db)
    .await?;

    let reviews = rows.into_iter().map(ReviewRow::into_record).collect::<AppResult<_>>()?;
    Ok(Json(ReviewList { reviews }))
}

#[derive(Deserialize)]
struct CreateReview {
    credential: Credential,
    model: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Progress {
    Status { message: String },
    Generating { chars: usize },
    Done { record: Box<ReviewRecord> },
    Error { message: String },
}

/// Generates a review and streams progress as server-sent events. The job runs
/// in its own task so the cache is still filled if the browser goes away.
async fn create_review(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
    Json(body): Json<CreateReview>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let model = body.model.trim().to_owned();
    if model.is_empty() || model.len() > 100 {
        return Err(AppError::BadRequest("choose a model".into()));
    }

    let (tx, rx) = mpsc::channel(32);
    tokio::spawn(async move {
        let job = Job {
            state,
            user,
            owner,
            repo,
            number,
            model,
            credential: body.credential,
            tx: tx.clone(),
        };
        let progress = match job.run().await {
            Ok(record) => Progress::Done {
                record: Box::new(record),
            },
            Err(err) => Progress::Error { message: err },
        };
        let _ = tx.send(progress).await;
    });

    let events =
        ReceiverStream::new(rx).map(|p| Ok(Event::default().data(serde_json::to_string(&p).unwrap_or_default())));
    Ok(Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

struct Job {
    state: AppState,
    user: CurrentUser,
    owner: String,
    repo: String,
    number: u64,
    model: String,
    credential: Credential,
    tx: mpsc::Sender<Progress>,
}

impl Job {
    async fn status(&self, message: &str) {
        let _ = self
            .tx
            .send(Progress::Status {
                message: message.into(),
            })
            .await;
    }

    /// Errors are returned as messages safe to show the user.
    async fn run(self) -> Result<ReviewRecord, String> {
        let app_err = |err: AppError| match err {
            AppError::Internal(_) => {
                tracing::error!("review job failed: {err:#}");
                "Something went wrong".to_owned()
            }
            other => other.to_string(),
        };

        self.status("Fetching pull request").await;
        let token = github::user_token(&self.state, self.user.id).await.map_err(app_err)?;
        let pr = pulls::fetch_pull(&self.state, &token, &self.owner, &self.repo, self.number)
            .await
            .map_err(app_err)?;
        let repo_id = pr.pull.repo_id().map_err(app_err)?;

        let prompt = prompt::build(&pr).map_err(|chars| {
            format!(
                "This pull request is too large for a single-pass review ({chars} characters of diff, limit {}).",
                prompt::MAX_INPUT_CHARS
            )
        })?;
        if prompt.required_hunks.is_empty() {
            return Err("Nothing to review: every change was collapsed by the pre-pass.".into());
        }

        let use_tools = prompt.input.len() <= prompt::MAX_TOOL_INPUT_CHARS;
        let instructions = if use_tools {
            format!("{}{}", prompt::INSTRUCTIONS, prompt::TOOL_INSTRUCTIONS)
        } else {
            prompt::INSTRUCTIONS.to_owned()
        };
        let definitions = if use_tools { tools::definitions() } else { Vec::new() };
        let mut toolbox = tools::Toolbox::new(Source::new(self.state.clone(), token, &pr).map_err(app_err)?);
        let mut input = vec![inference::user_message(&prompt.input)];

        let raw = 'turns: {
            for turn_number in 1..=MAX_TURNS {
                self.status("Generating review").await;
                let mut last_sent = 0;
                let turn = inference::respond(
                    &self.state.http,
                    &self.state.config.openai_base_url,
                    &self.credential,
                    inference::Request {
                        model: &self.model,
                        instructions: &instructions,
                        input: &input,
                        schema_name: output::SCHEMA_NAME,
                        schema: output::schema(),
                        tools: &definitions,
                        forbid_tools: toolbox.exhausted() || turn_number == MAX_TURNS,
                    },
                    |chars| {
                        if chars - last_sent >= 500 {
                            last_sent = chars;
                            // Progress is best-effort; drop it if the browser is slow or gone.
                            let _ = self.tx.try_send(Progress::Generating { chars });
                        }
                    },
                )
                .await
                .map_err(|err| format!("{err:#}"))?;

                let calls: Vec<_> = turn.function_calls().collect();
                if calls.is_empty() {
                    break 'turns turn.text;
                }
                let mut outputs = Vec::with_capacity(calls.len());
                for call in calls {
                    self.status(&tools::Toolbox::<Source>::describe(call.name, call.arguments))
                        .await;
                    let result = toolbox.call(call.name, call.arguments).await;
                    // Repository content is as untrusted as the diff.
                    let wrapped = format!("<{tag}>\n{result}\n</{tag}>", tag = prompt.tag);
                    outputs.push(inference::function_output(call.call_id, wrapped));
                }
                input.extend(turn.items.iter().cloned());
                input.extend(outputs);
            }
            return Err("The model kept calling tools without finishing the review.".into());
        };

        let review = output::parse(&raw, &prompt.required_hunks)
            .map_err(|err| format!("The model's review was invalid: {err}"))?;

        self.status("Saving").await;
        let review_json = serde_json::to_string(&review).map_err(|e| app_err(AppError::Internal(e.into())))?;
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO reviews (repo_id, pr_number, base_sha, head_sha, model, prompt_version, schema_version, requested_by, review_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (repo_id, pr_number, base_sha, head_sha, model, prompt_version, schema_version) DO UPDATE SET
               requested_by = excluded.requested_by, review_json = excluded.review_json, created_at = unixepoch()
             RETURNING id",
        )
        .bind(repo_id)
        .bind(self.number as i64)
        .bind(&pr.pull.base.sha)
        .bind(&pr.pull.head.sha)
        .bind(&self.model)
        .bind(prompt::PROMPT_VERSION)
        .bind(SCHEMA_VERSION as i64)
        .bind(self.user.id)
        .bind(&review_json)
        .fetch_one(&self.state.db)
        .await
        .map_err(|e| app_err(e.into()))?;

        let row: ReviewRow = sqlx::query_as(concat!(select_review!(), "WHERE r.id = ?"))
            .bind(id)
            .fetch_one(&self.state.db)
            .await
            .map_err(|e| app_err(e.into()))?;
        row.into_record().map_err(app_err)
    }
}

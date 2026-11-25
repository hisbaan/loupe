//! Guided reviews: generation (streamed over SSE) and the shared cache.

mod job;
mod output;
mod prompt;
mod self_review;
mod tools;

use std::{collections::BTreeMap, convert::Infallible};

use axum::{
    Json, Router,
    extract::{Path, State},
    response::sse::{Event, Sse},
    routing::get,
};
use futures_util::Stream;
use loupe_protocol::review::{GuidedReview, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};

use self::job::Effort;
use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    github,
    inference::Credential,
    pulls::{self, Author, PullResponse},
    source::Source,
    state::AppState,
    trust::{self, Trusted},
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/repos/{owner}/{repo}/pulls/{number}/reviews",
            get(list_reviews).post(create_review),
        )
        .merge(self_review::routes())
}

#[derive(Serialize)]
pub struct ReviewRecord {
    id: i64,
    model: String,
    prompt_version: i64,
    base_sha: String,
    head_sha: String,
    created_at: i64,
    effort: String,
    /// Repository files the model read.
    files_read: Vec<String>,
    requested_by: Author,
    /// Covers the pull request's current base and head commits.
    current: bool,
    trust: Trust,
    /// The viewer has chosen to see this requester's reviews without asking.
    auto_load: bool,
    /// The pull request's author asked for this review of their own change.
    requested_by_author: bool,
    updated_from: Option<UpdatedFrom>,
    review: GuidedReview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Trust {
    Mine,
    Trusted,
    Other,
}

#[derive(Serialize)]
struct UpdatedFrom {
    login: String,
    head_sha: String,
}

#[derive(sqlx::FromRow)]
struct ReviewRow {
    id: i64,
    model: String,
    prompt_version: i64,
    base_sha: String,
    head_sha: String,
    created_at: i64,
    effort: String,
    files_read: String,
    requested_by: i64,
    login: String,
    avatar_url: Option<String>,
    review_json: String,
    based_on_login: Option<String>,
    based_on_head_sha: Option<String>,
}

/// Who is looking at reviews of which pull request.
struct Viewer<'a> {
    user: &'a CurrentUser,
    trusted: &'a [Trusted],
    pr: &'a PullResponse,
}

impl Viewer<'_> {
    fn trust(&self, user_id: i64, login: &str) -> (Trust, bool) {
        if user_id == self.user.id {
            return (Trust::Mine, true);
        }
        match self.trusted.iter().find(|t| t.login.eq_ignore_ascii_case(login)) {
            Some(t) => (Trust::Trusted, t.auto_load),
            None => (Trust::Other, false),
        }
    }
}

impl ReviewRow {
    fn into_record(self, viewer: &Viewer) -> AppResult<ReviewRecord> {
        let (trust, auto_load) = viewer.trust(self.requested_by, &self.login);
        let pull = &viewer.pr.pull;
        Ok(ReviewRecord {
            id: self.id,
            model: self.model,
            prompt_version: self.prompt_version,
            current: self.base_sha == pull.base.sha && self.head_sha == pull.head.sha,
            base_sha: self.base_sha,
            head_sha: self.head_sha,
            created_at: self.created_at,
            effort: self.effort,
            files_read: serde_json::from_str(&self.files_read).unwrap_or_default(),
            trust,
            auto_load,
            requested_by_author: self.login.eq_ignore_ascii_case(&pull.user.login),
            requested_by: Author {
                login: self.login,
                avatar_url: self.avatar_url,
            },
            updated_from: self
                .based_on_login
                .zip(self.based_on_head_sha)
                .map(|(login, head_sha)| UpdatedFrom { login, head_sha }),
            review: serde_json::from_str(&self.review_json).map_err(anyhow::Error::from)?,
        })
    }
}

/// A macro so queries can `concat!` onto it and stay `&'static str`.
macro_rules! select_review {
    () => {
        "SELECT r.id, r.model, r.prompt_version, r.base_sha, r.head_sha, r.created_at, r.effort, r.files_read,
            r.requested_by,
            u.login, u.avatar_url, r.review_json, bu.login AS based_on_login, b.head_sha AS based_on_head_sha
         FROM reviews r JOIN users u ON u.id = r.requested_by
         LEFT JOIN reviews b ON b.id = r.based_on LEFT JOIN users bu ON bu.id = b.requested_by "
    };
}

/// How many reviews of earlier commits to return.
const MAX_OUTDATED: i64 = 20;

#[derive(Serialize)]
struct ReviewList {
    /// Reviews of the current commits first, then of earlier commits, newest first.
    reviews: Vec<ReviewRecord>,
}

/// Cached reviews of this pull request. Fetching the pull request with the
/// user's own token is the access check.
async fn list_reviews(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
) -> AppResult<Json<ReviewList>> {
    let token = github::user_token(&state, user.id).await?;
    let pr = pulls::fetch_pull(&state, &token, &owner, &repo, number).await?;
    let trusted = trust::trusted_by(&state.db, user.id).await?;

    let rows: Vec<ReviewRow> = sqlx::query_as(concat!(
        select_review!(),
        "WHERE r.repo_id = ? AND r.pr_number = ? AND r.prompt_version = ? AND r.schema_version = ?
         ORDER BY (r.base_sha = ? AND r.head_sha = ?) DESC, r.created_at DESC
         LIMIT ?"
    ))
    .bind(pr.pull.repo_id()?)
    .bind(number as i64)
    .bind(prompt::PROMPT_VERSION)
    .bind(SCHEMA_VERSION as i64)
    .bind(&pr.pull.base.sha)
    .bind(&pr.pull.head.sha)
    .bind(MAX_OUTDATED + 50)
    .fetch_all(&state.db)
    .await?;

    let viewer = Viewer {
        user: &user,
        trusted: &trusted,
        pr: &pr,
    };
    let mut reviews: Vec<ReviewRecord> = rows
        .into_iter()
        .map(|r| r.into_record(&viewer))
        .collect::<AppResult<_>>()?;
    let current = reviews.iter().filter(|r| r.current).count();
    reviews.truncate(current + MAX_OUTDATED as usize);
    Ok(Json(ReviewList { reviews }))
}

#[derive(Deserialize)]
struct CreateReview {
    credential: Credential,
    model: String,
    #[serde(default)]
    effort: Effort,
    /// An earlier review of this pull request (yours or a trusted reviewer's)
    /// to update: unchanged hunks keep their assessments.
    based_on: Option<i64>,
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

    Ok(job::stream(move |reporter| async move {
        Job {
            state,
            user,
            owner,
            repo,
            number,
            model,
            effort: body.effort,
            credential: body.credential,
            based_on: body.based_on,
            reporter,
        }
        .run()
        .await
    }))
}

struct Job {
    state: AppState,
    user: CurrentUser,
    owner: String,
    repo: String,
    number: u64,
    model: String,
    effort: Effort,
    credential: Credential,
    based_on: Option<i64>,
    reporter: job::Reporter,
}

impl Job {
    /// Errors are returned as messages safe to show the user.
    async fn run(self) -> Result<ReviewRecord, String> {
        let app_err = job::user_error;

        self.reporter.status("Fetching pull request").await;
        let token = github::user_token(&self.state, self.user.id).await.map_err(app_err)?;
        let pr = pulls::fetch_pull(&self.state, &token, &self.owner, &self.repo, self.number)
            .await
            .map_err(app_err)?;
        let repo_id = pr.pull.repo_id().map_err(app_err)?;

        let trusted = trust::trusted_by(&self.state.db, self.user.id).await.map_err(app_err)?;
        let viewer = Viewer {
            user: &self.user,
            trusted: &trusted,
            pr: &pr,
        };

        let base = match self.based_on {
            Some(id) => Some(self.load_base(id, repo_id, &viewer).await?),
            None => None,
        };
        // Hunk ids hash the path and hunk text, so an id that still exists
        // means the hunk is unchanged since the earlier review.
        let carried: BTreeMap<_, _> = match &base {
            Some(base) => {
                let current: std::collections::HashSet<&str> = pr
                    .files
                    .iter()
                    .flat_map(|f| &f.analysis.hunks)
                    .filter(|h| !h.collapsible)
                    .map(|h| h.id.as_str())
                    .collect();
                base.review
                    .hunks
                    .iter()
                    .filter(|(id, _)| current.contains(id.as_str()))
                    .map(|(id, a)| (id.clone(), a.clone()))
                    .collect()
            }
            None => BTreeMap::new(),
        };
        let previous = base.as_ref().map(|base| prompt::Previous {
            head_sha: &base.head_sha,
            summary: &base.review.summary,
            carried: &carried,
        });

        // Context only: a review still works without it.
        let stack = pulls::fetch_stack(&self.state, &token, &self.owner, &self.repo, self.number)
            .await
            .unwrap_or_else(|err| {
                tracing::warn!("reading the pull request's stack: {err}");
                None
            });

        let prompt = prompt::build(&pr, previous.as_ref(), stack.as_ref()).map_err(|chars| {
            format!(
                "This pull request is too large for a single-pass review ({chars} characters of diff, limit {}).",
                prompt::MAX_INPUT_CHARS
            )
        })?;
        if prompt.required_hunks.is_empty() && carried.is_empty() {
            return Err("Nothing to review: every change was collapsed by the pre-pass.".into());
        }

        let use_tools = prompt.input.len() <= prompt::MAX_TOOL_INPUT_CHARS;
        let mut instructions = prompt::INSTRUCTIONS.to_owned();
        if use_tools {
            instructions.push_str(&prompt::tool_instructions(self.effort.budget().calls));
        }
        if previous.is_some() {
            instructions.push_str(prompt::UPDATE_INSTRUCTIONS);
        }
        let toolbox = match use_tools {
            true => Some(tools::Toolbox::new(
                Source::new(self.state.clone(), token, &pr).map_err(app_err)?,
                self.effort.budget(),
            )),
            false => None,
        };
        let output = job::Generation {
            state: &self.state,
            credential: &self.credential,
            model: &self.model,
            effort: self.effort,
            reporter: &self.reporter,
            instructions: &instructions,
            tag: &prompt.tag,
            input: &prompt.input,
            schema_name: output::SCHEMA_NAME,
            schema: output::schema(),
            toolbox,
        }
        .run()
        .await?;

        let review = output::parse(&output.text, &prompt.required_hunks, &carried)
            .map_err(|err| format!("The model's review was invalid: {err}"))?;

        self.reporter.status("Saving").await;
        let review_json = serde_json::to_string(&review).map_err(|e| app_err(AppError::Internal(e.into())))?;
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO reviews (repo_id, pr_number, base_sha, head_sha, model, prompt_version, schema_version,
                                  requested_by, based_on, review_json, effort, files_read)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (repo_id, pr_number, base_sha, head_sha, model, prompt_version, schema_version, requested_by)
             DO UPDATE SET based_on = excluded.based_on, review_json = excluded.review_json, effort = excluded.effort,
                           files_read = excluded.files_read, created_at = unixepoch()
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
        .bind(base.as_ref().map(|b| b.id))
        .bind(&review_json)
        .bind(self.effort.as_str())
        .bind(serde_json::to_string(&output.files_read).unwrap_or_else(|_| "[]".into()))
        .fetch_one(&self.state.db)
        .await
        .map_err(|e| app_err(e.into()))?;

        let row: ReviewRow = sqlx::query_as(concat!(select_review!(), "WHERE r.id = ?"))
            .bind(id)
            .fetch_one(&self.state.db)
            .await
            .map_err(|e| app_err(e.into()))?;
        row.into_record(&viewer).map_err(app_err)
    }

    /// The earlier review to update. Only your own or a trusted reviewer's
    /// reviews of this same pull request qualify, since its assessments are
    /// carried into a review saved under your name.
    async fn load_base(&self, id: i64, repo_id: i64, viewer: &Viewer<'_>) -> Result<ReviewRecord, String> {
        let row: Option<ReviewRow> = sqlx::query_as(concat!(
            select_review!(),
            "WHERE r.id = ? AND r.repo_id = ? AND r.pr_number = ? AND r.prompt_version = ? AND r.schema_version = ?"
        ))
        .bind(id)
        .bind(repo_id)
        .bind(self.number as i64)
        .bind(prompt::PROMPT_VERSION)
        .bind(SCHEMA_VERSION as i64)
        .fetch_optional(&self.state.db)
        .await
        .map_err(|err| {
            tracing::error!("loading base review failed: {err:#}");
            "Something went wrong".to_owned()
        })?;
        let record = row
            .ok_or("That earlier review no longer exists or was made with an older prompt.")?
            .into_record(viewer)
            .map_err(|_| "Something went wrong".to_owned())?;
        if record.trust == Trust::Other {
            return Err("You can only update your own reviews or a trusted reviewer's.".into());
        }
        if record.current {
            return Err("That review already covers the latest commits.".into());
        }
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    /// 0005 rebuilds the reviews table; existing reviews must survive it.
    #[tokio::test]
    async fn sharing_migration_keeps_reviews() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for sql in [
            include_str!("../../migrations/0001_init.sql"),
            include_str!("../../migrations/0002_reviews.sql"),
            include_str!("../../migrations/0003_vault.sql"),
            include_str!("../../migrations/0004_source_cache.sql"),
        ] {
            sqlx::raw_sql(sql).execute(&db).await.unwrap();
        }
        sqlx::raw_sql(
            "INSERT INTO users (id, github_id, login) VALUES (1, 1, 'a');
             INSERT INTO reviews (repo_id, pr_number, base_sha, head_sha, model, prompt_version, schema_version,
                                  requested_by, review_json)
             VALUES (1, 2, 'b', 'h', 'm', 2, 1, 1, '{}');",
        )
        .execute(&db)
        .await
        .unwrap();

        sqlx::raw_sql(include_str!("../../migrations/0005_sharing.sql"))
            .execute(&db)
            .await
            .unwrap();

        let (requested_by, based_on, json): (i64, Option<i64>, String) =
            sqlx::query_as("SELECT requested_by, based_on, review_json FROM reviews")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!((requested_by, based_on, json.as_str()), (1, None, "{}"));
        // Two people can now hold a review under the same cache key.
        sqlx::raw_sql(
            "INSERT INTO users (id, github_id, login) VALUES (2, 2, 'b');
             INSERT INTO reviews (repo_id, pr_number, base_sha, head_sha, model, prompt_version, schema_version,
                                  requested_by, review_json)
             VALUES (1, 2, 'b', 'h', 'm', 2, 1, 2, '{}');",
        )
        .execute(&db)
        .await
        .unwrap();
    }
}

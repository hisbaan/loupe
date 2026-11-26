//! Agent notes: your private comments on a pull request's lines, handed to your
//! coding agent as markdown (the export happens in the browser). Also what you
//! decided about a review's findings. Every query is scoped to the requesting
//! user; nothing here reaches GitHub.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch, post, put},
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    github, pulls,
    state::AppState,
};

const MAX_BODY_CHARS: usize = 65_536;
const MAX_PATH_CHARS: usize = 4_096;
const MAX_SNIPPET_BYTES: usize = 32 * 1024;
const MAX_KEY_CHARS: usize = 512;
const MAX_NOTES_PER_PULL: i64 = 500;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/repos/{owner}/{repo}/pulls/{number}/notes", get(list).post(create))
        .route("/repos/{owner}/{repo}/pulls/{number}/notes/hand-off", post(hand_off))
        .route("/repos/{owner}/{repo}/pulls/{number}/finding-decisions", put(decide))
        .route("/notes/{id}", patch(update).delete(remove))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct Note {
    id: i64,
    path: String,
    /// `new` or `old`.
    side: String,
    start_line: i64,
    end_line: i64,
    /// The commit the lines refer to.
    head_sha: String,
    /// The hunk the lines were in; while it's still in the diff, so are they.
    hunk_id: Option<String>,
    snippet: Option<String>,
    body: String,
    finding_key: Option<String>,
    resolved: bool,
    handed_off_sha: Option<String>,
    handed_off_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

/// A macro so queries can `concat!` onto it and stay `&'static str`.
macro_rules! columns {
    () => {
        "id, path, side, start_line, end_line, head_sha, hunk_id, snippet, body, finding_key, resolved,
         handed_off_sha, handed_off_at, created_at, updated_at"
    };
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct Decision {
    finding_key: String,
    /// `dismissed` or `github`.
    decision: String,
}

#[derive(Serialize)]
struct NoteList {
    /// Oldest first.
    notes: Vec<Note>,
    decisions: Vec<Decision>,
}

/// The repository id for a pull request, fetched with the user's token: the
/// access check for everything here that names a pull request.
async fn repo_id(state: &AppState, user: &CurrentUser, owner: &str, repo: &str, number: u64) -> AppResult<i64> {
    let token = github::user_token(state, user.id).await?;
    pulls::fetch_pull_only(state, &token, owner, repo, number)
        .await?
        .repo_id()
}

async fn list(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
) -> AppResult<Json<NoteList>> {
    let repo_id = repo_id(&state, &user, &owner, &repo, number).await?;
    let notes: Vec<Note> = sqlx::query_as(concat!(
        "SELECT ",
        columns!(),
        " FROM agent_notes WHERE user_id = ? AND repo_id = ? AND pr_number = ? ORDER BY created_at, id"
    ))
    .bind(user.id)
    .bind(repo_id)
    .bind(number as i64)
    .fetch_all(&state.db)
    .await?;
    let decisions: Vec<Decision> = sqlx::query_as(
        "SELECT finding_key, decision FROM finding_decisions WHERE user_id = ? AND repo_id = ? AND pr_number = ?",
    )
    .bind(user.id)
    .bind(repo_id)
    .bind(number as i64)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(NoteList { notes, decisions }))
}

#[derive(Deserialize)]
struct NewNote {
    path: String,
    side: String,
    start_line: i64,
    end_line: i64,
    head_sha: String,
    hunk_id: Option<String>,
    snippet: Option<String>,
    body: String,
    finding_key: Option<String>,
}

async fn create(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
    Json(new): Json<NewNote>,
) -> AppResult<Json<Note>> {
    let body = check_body(&new.body)?;
    if new.path.is_empty() || new.path.len() > MAX_PATH_CHARS {
        return Err(AppError::BadRequest("invalid path".into()));
    }
    if !matches!(new.side.as_str(), "new" | "old") {
        return Err(AppError::BadRequest("invalid side".into()));
    }
    if new.start_line < 1 || new.start_line > new.end_line {
        return Err(AppError::BadRequest("invalid line range".into()));
    }
    check_sha(&new.head_sha)?;
    if new.hunk_id.as_deref().is_some_and(|id| !is_token(id, 128)) {
        return Err(AppError::BadRequest("invalid hunk".into()));
    }
    if new.snippet.as_ref().is_some_and(|s| s.len() > MAX_SNIPPET_BYTES) {
        return Err(AppError::BadRequest("snippet too long".into()));
    }
    let finding_key = new.finding_key.as_deref().map(check_key).transpose()?;

    let repo_id = repo_id(&state, &user, &owner, &repo, number).await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM agent_notes WHERE user_id = ? AND repo_id = ? AND pr_number = ?")
            .bind(user.id)
            .bind(repo_id)
            .bind(number as i64)
            .fetch_one(&state.db)
            .await?;
    if count >= MAX_NOTES_PER_PULL {
        return Err(AppError::BadRequest("too many notes on this pull request".into()));
    }

    let note: Note = sqlx::query_as(concat!(
        "INSERT INTO agent_notes (user_id, repo_id, pr_number, path, side, start_line, end_line, head_sha, hunk_id,
                                  snippet, body, finding_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ",
        columns!()
    ))
    .bind(user.id)
    .bind(repo_id)
    .bind(number as i64)
    .bind(&new.path)
    .bind(&new.side)
    .bind(new.start_line)
    .bind(new.end_line)
    .bind(&new.head_sha)
    .bind(&new.hunk_id)
    .bind(&new.snippet)
    .bind(body)
    .bind(finding_key)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(note))
}

#[derive(Deserialize)]
struct NoteChange {
    body: Option<String>,
    resolved: Option<bool>,
}

async fn update(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(change): Json<NoteChange>,
) -> AppResult<Json<Note>> {
    let body = change.body.as_deref().map(check_body).transpose()?;
    let note: Option<Note> = sqlx::query_as(concat!(
        "UPDATE agent_notes SET body = coalesce(?, body), resolved = coalesce(?, resolved), updated_at = unixepoch()
         WHERE id = ? AND user_id = ?
         RETURNING ",
        columns!()
    ))
    .bind(body)
    .bind(change.resolved)
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?;
    note.map(Json).ok_or(AppError::NotFound)
}

async fn remove(user: CurrentUser, State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<StatusCode> {
    let deleted = sqlx::query("DELETE FROM agent_notes WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&state.db)
        .await?
        .rows_affected();
    match deleted {
        1 => Ok(StatusCode::NO_CONTENT),
        _ => Err(AppError::NotFound),
    }
}

#[derive(Deserialize)]
struct HandOff {
    /// The head commit the export was made from.
    head_sha: String,
}

/// Records that your open notes on this pull request went to your agent, so
/// the page can tell you which ones the agent's next push touched.
async fn hand_off(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
    Json(request): Json<HandOff>,
) -> AppResult<StatusCode> {
    check_sha(&request.head_sha)?;
    let repo_id = repo_id(&state, &user, &owner, &repo, number).await?;
    sqlx::query(
        "UPDATE agent_notes SET handed_off_sha = ?, handed_off_at = unixepoch()
         WHERE user_id = ? AND repo_id = ? AND pr_number = ? AND resolved = 0",
    )
    .bind(&request.head_sha)
    .bind(user.id)
    .bind(repo_id)
    .bind(number as i64)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct DecisionRequest {
    finding_key: String,
    /// `dismissed`, `github`, or `None` to undo.
    decision: Option<String>,
}

async fn decide(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
    Json(request): Json<DecisionRequest>,
) -> AppResult<StatusCode> {
    let key = check_key(&request.finding_key)?;
    if request
        .decision
        .as_deref()
        .is_some_and(|d| !matches!(d, "dismissed" | "github"))
    {
        return Err(AppError::BadRequest("invalid decision".into()));
    }
    let repo_id = repo_id(&state, &user, &owner, &repo, number).await?;
    match request.decision {
        Some(decision) => {
            sqlx::query(
                "INSERT INTO finding_decisions (user_id, repo_id, pr_number, finding_key, decision)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (user_id, repo_id, pr_number, finding_key)
                 DO UPDATE SET decision = excluded.decision, created_at = unixepoch()",
            )
            .bind(user.id)
            .bind(repo_id)
            .bind(number as i64)
            .bind(key)
            .bind(decision)
            .execute(&state.db)
            .await?;
        }
        None => {
            sqlx::query(
                "DELETE FROM finding_decisions WHERE user_id = ? AND repo_id = ? AND pr_number = ? AND finding_key = ?",
            )
            .bind(user.id)
            .bind(repo_id)
            .bind(number as i64)
            .bind(key)
            .execute(&state.db)
            .await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

fn check_body(body: &str) -> AppResult<&str> {
    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::BadRequest("the note is empty".into()));
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(AppError::BadRequest("that note is too long".into()));
    }
    Ok(body)
}

fn check_key(key: &str) -> AppResult<&str> {
    if key.is_empty() || key.chars().count() > MAX_KEY_CHARS {
        return Err(AppError::BadRequest("invalid finding".into()));
    }
    Ok(key)
}

/// A commit SHA: 40 (SHA-1) or 64 (SHA-256) lowercase hex digits.
fn check_sha(sha: &str) -> AppResult<()> {
    let valid = matches!(sha.len(), 40 | 64) && sha.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'));
    if valid {
        Ok(())
    } else {
        Err(AppError::BadRequest("invalid commit".into()))
    }
}

fn is_token(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    #[test]
    fn validates_shas() {
        assert!(check_sha(&"a".repeat(40)).is_ok());
        assert!(check_sha(&"0".repeat(64)).is_ok());
        assert!(check_sha("abc").is_err());
        assert!(check_sha(&"A".repeat(40)).is_err());
    }

    /// 0009 turns self-review comments and accepted findings into agent notes.
    #[tokio::test]
    async fn migration_keeps_self_review_notes() {
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
            include_str!("../../migrations/0005_sharing.sql"),
            include_str!("../../migrations/0006_self_reviews.sql"),
            include_str!("../../migrations/0007_user_settings.sql"),
            include_str!("../../migrations/0008_effort.sql"),
        ] {
            sqlx::raw_sql(sql).execute(&db).await.unwrap();
        }
        let review = serde_json::json!({ "findings": [
            { "id": "f1", "path": "a.rs", "side": "new", "start_line": 3, "end_line": 4, "title": "Kept", "body": "why" },
            { "id": "f2", "path": "b.rs", "side": "new", "start_line": 1, "end_line": 1, "title": "Dropped", "body": "no" },
        ] });
        let notes = serde_json::json!({
            "findings": { "f1": { "status": "accepted", "body": "edited" }, "f2": { "status": "dismissed" } },
            "comments": [{ "id": "c", "path": "c.rs", "side": "old", "start_line": 7, "end_line": 9, "body": "mine" }],
        });
        sqlx::query("INSERT INTO users (id, github_id, login) VALUES (1, 1, 'a')")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO self_reviews (user_id, repo_id, pr_number, base_sha, head_sha, model, prompt_version,
                                       schema_version, review_json, notes_json)
             VALUES (1, 2, 3, 'b', 'h', 'm', 5, 2, ?, ?)",
        )
        .bind(review.to_string())
        .bind(notes.to_string())
        .execute(&db)
        .await
        .unwrap();

        sqlx::raw_sql(include_str!("../../migrations/0009_agent_notes.sql"))
            .execute(&db)
            .await
            .unwrap();

        let rows: Vec<(String, String, i64, i64, String, String)> =
            sqlx::query_as("SELECT path, side, start_line, end_line, head_sha, body FROM agent_notes ORDER BY path")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(
            rows,
            vec![
                ("a.rs".into(), "new".into(), 3, 4, "h".into(), "Kept\n\nedited".into()),
                ("c.rs".into(), "old".into(), 7, 9, "h".into(), "mine".into()),
            ]
        );
        let gone: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'self_reviews'")
                .fetch_optional(&db)
                .await
                .unwrap();
        assert_eq!(gone, None);
    }
}

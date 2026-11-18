//! Pull request data for the diff view.

use axum::{
    Json, Router,
    extract::{Path, State},
    routing::get,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    github::{self, get_json},
    state::AppState,
};

/// GitHub stops returning files after 3000 (30 pages of 100).
const MAX_FILE_PAGES: u32 = 30;

pub fn routes() -> Router<AppState> {
    Router::new().route("/repos/{owner}/{repo}/pulls/{number}", get(get_pull))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitRef {
    #[serde(rename = "ref")]
    pub name: String,
    pub sha: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Author {
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Pull {
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub draft: Option<bool>,
    pub html_url: String,
    pub user: Author,
    pub base: GitRef,
    pub head: GitRef,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PullFile {
    pub filename: String,
    pub previous_filename: Option<String>,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    /// Absent for binary files and diffs GitHub considers too large.
    pub patch: Option<String>,
}

#[derive(Serialize)]
pub struct PullResponse {
    pull: Pull,
    files: Vec<PullFile>,
    truncated: bool,
}

async fn get_pull(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
) -> AppResult<Json<PullResponse>> {
    if !is_github_name(&owner) || !is_github_name(&repo) {
        return Err(AppError::BadRequest("invalid owner or repo".into()));
    }
    let token = github::user_token(&state, user.id).await?;
    let base = format!("/repos/{owner}/{repo}/pulls/{number}");

    let pull: Pull = get_json(&state, &token, &base).await?;

    let mut files = Vec::new();
    let mut truncated = true;
    for page in 1..=MAX_FILE_PAGES {
        let batch: Vec<PullFile> = get_json(&state, &token, &format!("{base}/files?per_page=100&page={page}")).await?;
        let last = batch.len() < 100;
        files.extend(batch);
        if last {
            truncated = false;
            break;
        }
    }

    Ok(Json(PullResponse { pull, files, truncated }))
}

/// GitHub owner/repo names: alphanumerics, `-`, `_`, `.`; keeps arbitrary
/// path segments out of API URLs.
fn is_github_name(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

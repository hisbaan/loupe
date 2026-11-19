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
    prepass::{self, FileAnalysis, FileInput},
    state::AppState,
};

/// GitHub stops returning files after 3000 (30 pages of 100).
const MAX_FILE_PAGES: u32 = 30;

pub fn routes() -> Router<AppState> {
    Router::new().route("/repos/{owner}/{repo}/pulls/{number}", get(get_pull))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Repo {
    pub id: i64,
    pub full_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRef {
    #[serde(rename = "ref")]
    pub name: String,
    pub sha: String,
    pub repo: Option<Repo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Author {
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

impl Pull {
    /// The repository the pull request targets; reviews are keyed by it.
    pub fn repo_id(&self) -> AppResult<i64> {
        self.base
            .repo
            .as_ref()
            .map(|r| r.id)
            .ok_or_else(|| AppError::Internal(anyhow::anyhow!("pull request has no base repository")))
    }
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

#[derive(Debug, Serialize)]
pub struct AnalyzedFile {
    #[serde(flatten)]
    pub file: PullFile,
    pub analysis: FileAnalysis,
}

#[derive(Debug, Serialize)]
pub struct PullResponse {
    pub pull: Pull,
    pub files: Vec<AnalyzedFile>,
    pub truncated: bool,
}

/// Fetches a pull request and its files with `token` and runs the pre-pass.
/// Because the token is the requesting user's, a successful fetch is also the
/// access check for anything cached about this pull request.
pub async fn fetch_pull(
    state: &AppState,
    token: &str,
    owner: &str,
    repo: &str,
    number: u64,
) -> AppResult<PullResponse> {
    if !is_github_name(owner) || !is_github_name(repo) {
        return Err(AppError::BadRequest("invalid owner or repo".into()));
    }
    let base = format!("/repos/{owner}/{repo}/pulls/{number}");
    let pull: Pull = get_json(state, token, &base).await?;

    let mut files = Vec::new();
    let mut truncated = true;
    for page in 1..=MAX_FILE_PAGES {
        let batch: Vec<PullFile> = get_json(state, token, &format!("{base}/files?per_page=100&page={page}")).await?;
        let last = batch.len() < 100;
        files.extend(batch);
        if last {
            truncated = false;
            break;
        }
    }

    let files = files
        .into_iter()
        .map(|file| {
            let analysis = prepass::analyze(FileInput {
                filename: &file.filename,
                status: &file.status,
                patch: file.patch.as_deref(),
            });
            AnalyzedFile { file, analysis }
        })
        .collect();

    Ok(PullResponse { pull, files, truncated })
}

async fn get_pull(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
) -> AppResult<Json<PullResponse>> {
    let token = github::user_token(&state, user.id).await?;
    Ok(Json(fetch_pull(&state, &token, &owner, &repo, number).await?))
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

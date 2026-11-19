//! GitHub API access. Every call is made with the *requesting user's* token, so
//! GitHub itself enforces repo access: a user can never see a PR, file or
//! cached artifact through Loupe that they couldn't see on github.com.

mod tokens;

use axum::http::StatusCode;
use serde::{Deserialize, de::DeserializeOwned};

use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

pub use tokens::{exchange_code, store_tokens, user_token};

const API_BASE: &str = "https://api.github.com";

#[derive(Debug, Deserialize)]
pub struct GitHubUser {
    pub id: i64,
    pub login: String,
    pub avatar_url: Option<String>,
}

async fn get(state: &AppState, token: &str, path: &str, accept: &str) -> AppResult<reqwest::Response> {
    let response = state
        .http
        .get(format!("{API_BASE}{path}"))
        .bearer_auth(token)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        tracing::warn!(%status, path, "GitHub request failed");
        return Err(AppError::GitHub {
            status: StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
        });
    }
    Ok(response)
}

pub async fn get_json<T: DeserializeOwned>(state: &AppState, token: &str, path: &str) -> AppResult<T> {
    Ok(get(state, token, path, "application/vnd.github+json")
        .await?
        .json()
        .await?)
}

/// Raw bytes, e.g. of a blob.
pub async fn get_raw(state: &AppState, token: &str, path: &str) -> AppResult<Vec<u8>> {
    Ok(get(state, token, path, "application/vnd.github.raw+json")
        .await?
        .bytes()
        .await?
        .to_vec())
}

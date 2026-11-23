//! GitHub API access. Every call is made with the *requesting user's* token, so
//! GitHub itself enforces repo access: a user can never see a PR, file or
//! cached artifact through Loupe that they couldn't see on github.com.

mod tokens;

use axum::http::StatusCode;
use reqwest::Method;
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

async fn send_get(state: &AppState, token: &str, path: &str, accept: &str) -> AppResult<reqwest::Response> {
    Ok(state
        .http
        .get(format!("{API_BASE}{path}"))
        .bearer_auth(token)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?)
}

async fn get(state: &AppState, token: &str, path: &str, accept: &str) -> AppResult<reqwest::Response> {
    let response = send_get(state, token, path, accept).await?;
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

/// Like [`get_json`], but a 404 is `None` and isn't logged: for endpoints
/// that may not exist for a repository.
pub async fn get_json_if_found<T: DeserializeOwned>(state: &AppState, token: &str, path: &str) -> AppResult<Option<T>> {
    let response = send_get(state, token, path, "application/vnd.github+json").await?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        tracing::warn!(%status, path, "GitHub request failed");
        return Err(AppError::GitHub {
            status: StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
        });
    }
    Ok(Some(response.json().await?))
}

#[derive(Debug, Deserialize)]
pub struct GraphQlResponse<T> {
    pub data: Option<T>,
    /// Fields GitHub couldn't resolve, e.g. an inaccessible repository; those
    /// come back as `null` in `data` while the rest still resolves.
    #[serde(default)]
    pub errors: Vec<GraphQlError>,
}

#[derive(Debug, Deserialize)]
pub struct GraphQlError {
    pub message: String,
    /// e.g. `NOT_FOUND`, `FORBIDDEN`.
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

/// A GraphQL query. Pass untrusted values (repository names) as `variables`,
/// never interpolated into `query`.
pub async fn graphql<T: DeserializeOwned>(
    state: &AppState,
    token: &str,
    query: &str,
    variables: serde_json::Value,
) -> AppResult<GraphQlResponse<T>> {
    let response = state
        .http
        .post(format!("{API_BASE}/graphql"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "query": query, "variables": variables }))
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        tracing::warn!(%status, "GitHub GraphQL request failed");
        return Err(AppError::GitHub {
            status: StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
        });
    }
    Ok(response.json().await?)
}

/// Raw bytes, e.g. of a blob.
pub async fn get_raw(state: &AppState, token: &str, path: &str) -> AppResult<Vec<u8>> {
    Ok(get(state, token, path, "application/vnd.github.raw+json")
        .await?
        .bytes()
        .await?
        .to_vec())
}

/// A write with a JSON body, made only on an explicit request from the user.
/// On failure GitHub's own explanation is passed through (see [`rejected`]).
pub async fn send_json<T: DeserializeOwned>(
    state: &AppState,
    token: &str,
    method: Method,
    path: &str,
    body: &serde_json::Value,
) -> AppResult<T> {
    let response = state
        .http
        .request(method, format!("{API_BASE}{path}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        tracing::warn!(%status, path, "GitHub write failed");
        let body: serde_json::Value = response.json().await.unwrap_or_default();
        return Err(rejected(status.as_u16(), rest_message(&body)));
    }
    Ok(response.json().await?)
}

/// A GraphQL mutation. Unlike [`graphql`], any error fails the call, with
/// GitHub's message passed through.
pub async fn mutate<T: DeserializeOwned>(
    state: &AppState,
    token: &str,
    query: &str,
    variables: serde_json::Value,
) -> AppResult<T> {
    let response = graphql::<T>(state, token, query, variables).await?;
    if let Some(error) = response.errors.first() {
        tracing::warn!(kind = ?error.kind, "GitHub mutation failed");
        let status = match error.kind.as_deref() {
            Some("FORBIDDEN") => 403,
            Some("NOT_FOUND") => 404,
            _ => 422,
        };
        return Err(rejected(status, Some(error.message.clone())));
    }
    response
        .data
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("GitHub mutation returned no data")))
}

/// REST errors look like `{"message": "Validation Failed", "errors": [...]}`,
/// where the details are strings or objects with a `message`.
fn rest_message(body: &serde_json::Value) -> Option<String> {
    let message = body["message"].as_str()?;
    let detail = body["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|e| e.as_str().or_else(|| e["message"].as_str()));
    Some(match detail {
        Some(detail) => format!("{message}: {detail}"),
        None => message.to_owned(),
    })
}

/// GitHub refused a write. Its message says why ("Can not approve your own
/// pull request"), so it's shown to the user. A GitHub App user token can only
/// write where the app is installed with write access, which GitHub reports as
/// "Resource not accessible by integration"; that one gets a clearer message.
fn rejected(status: u16, message: Option<String>) -> AppError {
    const MAX_MESSAGE_CHARS: usize = 300;
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let message = match message {
        Some(m) if m.contains("not accessible by integration") => {
            "Loupe's GitHub App can't write to this repository. It needs to be installed on the repository's \
             account, and an owner has to accept its updated permissions."
                .to_owned()
        }
        Some(m) => m.chars().take(MAX_MESSAGE_CHARS).collect(),
        None => format!("GitHub returned {status}"),
    };
    AppError::GitHubRejected { status, message }
}

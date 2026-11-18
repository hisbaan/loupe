//! GitHub App user-to-server tokens: exchange, encrypted storage, and refresh.
//! Expiring user tokens (8h, refreshable for 6 months) are the GitHub App
//! default; non-expiring tokens are handled too.

use anyhow::Context;
use serde::Deserialize;

use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
/// Refresh this long before the access token actually expires.
const REFRESH_SKEW_SECS: i64 = 300;

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub expires_in: Option<i64>,
    pub refresh_token: Option<String>,
    pub refresh_token_expires_in: Option<i64>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum TokenResult {
    Ok(TokenResponse),
    Err {
        error: String,
        error_description: Option<String>,
    },
}

async fn request_token(state: &AppState, form: &[(&str, &str)]) -> AppResult<TokenResponse> {
    let result: TokenResult = state
        .http
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .form(form)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    match result {
        TokenResult::Ok(tokens) => Ok(tokens),
        TokenResult::Err {
            error,
            error_description,
        } => {
            tracing::warn!(error, ?error_description, "GitHub token request failed");
            Err(AppError::Unauthorized)
        }
    }
}

pub async fn exchange_code(state: &AppState, code: &str, redirect_uri: &str) -> AppResult<TokenResponse> {
    request_token(
        state,
        &[
            ("client_id", &state.config.github_client_id),
            ("client_secret", &state.config.github_client_secret),
            ("code", code),
            ("redirect_uri", redirect_uri),
        ],
    )
    .await
}

pub async fn store_tokens(state: &AppState, user_id: i64, tokens: &TokenResponse) -> AppResult<()> {
    let now = now();
    sqlx::query(
        "INSERT INTO github_tokens (user_id, access_token_enc, access_expires_at, refresh_token_enc, refresh_expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           access_token_enc = excluded.access_token_enc,
           access_expires_at = excluded.access_expires_at,
           refresh_token_enc = excluded.refresh_token_enc,
           refresh_expires_at = excluded.refresh_expires_at,
           updated_at = unixepoch()",
    )
    .bind(user_id)
    .bind(state.cipher.encrypt(tokens.access_token.as_bytes()))
    .bind(tokens.expires_in.map(|s| now + s))
    .bind(tokens.refresh_token.as_ref().map(|t| state.cipher.encrypt(t.as_bytes())))
    .bind(tokens.refresh_token_expires_in.map(|s| now + s))
    .execute(&state.db)
    .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct StoredTokens {
    access_token_enc: Vec<u8>,
    access_expires_at: Option<i64>,
    refresh_token_enc: Option<Vec<u8>>,
}

/// A valid GitHub token for `user_id`, refreshing it if it's about to expire.
/// Returns `Unauthorized` when the user has to sign in again.
pub async fn user_token(state: &AppState, user_id: i64) -> AppResult<String> {
    let stored: StoredTokens = sqlx::query_as(
        "SELECT access_token_enc, access_expires_at, refresh_token_enc FROM github_tokens WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::Unauthorized)?;

    let fresh = stored
        .access_expires_at
        .is_none_or(|exp| exp - REFRESH_SKEW_SECS > now());
    if fresh {
        return decrypt(state, &stored.access_token_enc);
    }

    let refresh_token = decrypt(
        state,
        stored.refresh_token_enc.as_deref().ok_or(AppError::Unauthorized)?,
    )?;
    let tokens = request_token(
        state,
        &[
            ("client_id", &state.config.github_client_id),
            ("client_secret", &state.config.github_client_secret),
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh_token),
        ],
    )
    .await?;
    store_tokens(state, user_id, &tokens).await?;
    Ok(tokens.access_token)
}

fn decrypt(state: &AppState, blob: &[u8]) -> AppResult<String> {
    let bytes = state
        .cipher
        .decrypt(blob)
        .context("failed to decrypt GitHub token; was LOUPE_SECRET_KEY changed?")?;
    Ok(String::from_utf8(bytes).context("GitHub token is not UTF-8")?)
}

fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

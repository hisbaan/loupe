use axum::{extract::FromRequestParts, http::request::Parts};
use axum_extra::extract::CookieJar;

use super::SESSION_COOKIE;
use crate::{crypto::sha256, error::AppError, state::AppState};

/// The signed-in user. Use as an extractor to require a session.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CurrentUser {
    pub id: i64,
    pub login: String,
    pub avatar_url: Option<String>,
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar.get(SESSION_COOKIE).ok_or(AppError::Unauthorized)?;

        sqlx::query_as(
            "SELECT u.id, u.login, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ? AND s.expires_at > unixepoch()",
        )
        .bind(sha256(token.value()))
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::Unauthorized)
    }
}

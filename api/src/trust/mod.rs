//! Per-user lists of trusted reviewers: GitHub logins whose cached reviews are
//! offered first (or shown straight away with `auto_load`), and whose reviews
//! may be updated incrementally. Trust only affects presentation; access to a
//! review is always checked against the reader's own GitHub permissions.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, put},
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    state::AppState,
};

const MAX_TRUSTED: i64 = 200;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/trusted", get(list))
        .route("/trusted/{login}", put(upsert).delete(remove))
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Trusted {
    pub login: String,
    pub auto_load: bool,
}

pub async fn trusted_by(db: &sqlx::SqlitePool, user_id: i64) -> AppResult<Vec<Trusted>> {
    Ok(
        sqlx::query_as("SELECT login, auto_load FROM trusted_users WHERE user_id = ? ORDER BY login COLLATE NOCASE")
            .bind(user_id)
            .fetch_all(db)
            .await?,
    )
}

/// GitHub logins: alphanumerics and single hyphens, at most 39 characters.
pub fn valid_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 39
        && login.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !login.starts_with('-')
        && !login.ends_with('-')
        && !login.contains("--")
}

#[derive(Serialize)]
struct TrustedList {
    trusted: Vec<Trusted>,
}

async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<TrustedList>> {
    Ok(Json(TrustedList {
        trusted: trusted_by(&state.db, user.id).await?,
    }))
}

#[derive(Deserialize)]
struct Upsert {
    auto_load: bool,
}

async fn upsert(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(login): Path<String>,
    Json(body): Json<Upsert>,
) -> AppResult<Json<Trusted>> {
    if !valid_login(&login) {
        return Err(AppError::BadRequest("that isn't a valid GitHub username".into()));
    }
    if login.eq_ignore_ascii_case(&user.login) {
        return Err(AppError::BadRequest("your own reviews are always trusted".into()));
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM trusted_users WHERE user_id = ? AND login != ?")
        .bind(user.id)
        .bind(&login)
        .fetch_one(&state.db)
        .await?;
    if count >= MAX_TRUSTED {
        return Err(AppError::BadRequest(format!(
            "you can trust at most {MAX_TRUSTED} people"
        )));
    }
    sqlx::query(
        "INSERT INTO trusted_users (user_id, login, auto_load) VALUES (?, ?, ?)
         ON CONFLICT (user_id, login) DO UPDATE SET auto_load = excluded.auto_load",
    )
    .bind(user.id)
    .bind(&login)
    .bind(body.auto_load)
    .execute(&state.db)
    .await?;
    Ok(Json(Trusted {
        login,
        auto_load: body.auto_load,
    }))
}

async fn remove(State(state): State<AppState>, user: CurrentUser, Path(login): Path<String>) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM trusted_users WHERE user_id = ? AND login = ?")
        .bind(user.id)
        .bind(&login)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_logins() {
        assert!(valid_login("octo-cat"));
        assert!(valid_login("a1"));
        assert!(!valid_login("-octo"));
        assert!(!valid_login("octo--cat"));
        assert!(!valid_login("octo/cat"));
        assert!(!valid_login(&"a".repeat(40)));
    }
}

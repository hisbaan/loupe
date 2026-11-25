//! Per-user preferences, stored so they follow the user between computers.
//! The web client owns the shape and validates what it reads back; the server
//! only checks it's a small JSON object. Never put credentials in here: the
//! inference vault is the only place for those.

use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde_json::Value;

use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    state::AppState,
};

const MAX_SETTINGS_BYTES: usize = 16 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new().route("/settings", get(load).put(save))
}

/// Your settings, or an empty object if you've never saved any.
async fn load(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    let json: Option<String> = sqlx::query_scalar("SELECT settings_json FROM user_settings WHERE user_id = ?")
        .bind(user.id)
        .fetch_optional(&state.db)
        .await?;
    let settings = json
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_else(|| Value::Object(Default::default()));
    Ok(Json(settings))
}

/// Replaces your settings.
async fn save(State(state): State<AppState>, user: CurrentUser, Json(settings): Json<Value>) -> AppResult<StatusCode> {
    if !settings.is_object() {
        return Err(AppError::BadRequest("settings must be an object".into()));
    }
    let json = settings.to_string();
    if json.len() > MAX_SETTINGS_BYTES {
        return Err(AppError::BadRequest("settings are too large".into()));
    }
    sqlx::query(
        "INSERT INTO user_settings (user_id, settings_json) VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = unixepoch()",
    )
    .bind(user.id)
    .bind(json)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

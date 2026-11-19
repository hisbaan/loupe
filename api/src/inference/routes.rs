use axum::{Json, Router, extract::State, routing::post};
use loupe_protocol::siwc::{TOKEN_URL, Tokens};
use serde::{Deserialize, Serialize};

use super::{Credential, chatgpt};
use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    state::AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/inference/models", post(list_models))
        .route("/inference/chatgpt/refresh", post(refresh_chatgpt))
}

#[derive(Deserialize)]
struct ModelsRequest {
    credential: Credential,
}

#[derive(Serialize)]
struct ModelsResponse {
    models: Vec<String>,
}

async fn list_models(
    _user: CurrentUser,
    State(state): State<AppState>,
    Json(body): Json<ModelsRequest>,
) -> AppResult<Json<ModelsResponse>> {
    let models = super::list_models(&state.http, &state.config.openai_base_url, &body.credential)
        .await
        .map_err(|err| AppError::BadRequest(format!("{err:#}")))?;
    Ok(Json(ModelsResponse { models }))
}

#[derive(Deserialize)]
struct RefreshRequest {
    client_id: String,
    refresh_token: String,
}

/// Signed-in users only, so this isn't an open relay to OpenAI.
async fn refresh_chatgpt(
    _user: CurrentUser,
    State(state): State<AppState>,
    Json(body): Json<RefreshRequest>,
) -> AppResult<Json<Tokens>> {
    let valid_client_id = !body.client_id.is_empty()
        && body.client_id.len() <= 200
        && body
            .client_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b));
    if !valid_client_id || body.refresh_token.is_empty() || body.refresh_token.len() > 8192 {
        return Err(AppError::BadRequest("invalid refresh request".into()));
    }
    chatgpt::refresh(&state.http, TOKEN_URL, &body.client_id, &body.refresh_token)
        .await
        .map(Json)
        .map_err(|err| match err.downcast::<chatgpt::Expired>() {
            // Tells the browser to ask for a new sign-in rather than retry.
            Ok(expired) => AppError::Gone(expired.to_string()),
            Err(err) => AppError::BadRequest(format!("{err:#}")),
        })
}

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not signed in")]
    Unauthorized,
    #[error("{0}")]
    BadRequest(String),
    #[error("not found")]
    NotFound,
    #[error("Loupe isn't connected to GitHub yet; an admin needs to finish setup")]
    NotConfigured,
    #[error("{0}")]
    Conflict(String),
    /// Something the client holds has expired for good, e.g. a revoked grant.
    #[error("{0}")]
    Gone(String),
    #[error("GitHub returned {status}")]
    GitHub { status: StatusCode },
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        Self::Internal(err.into())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        Self::Internal(err.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::NotConfigured => StatusCode::SERVICE_UNAVAILABLE,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Gone(_) => StatusCode::GONE,
            // A 404 from GitHub with the user's own token is also how missing
            // access to a private repo looks, so pass those through.
            Self::GitHub { status } if status.is_client_error() => *status,
            Self::GitHub { .. } => StatusCode::BAD_GATEWAY,
            Self::Internal(err) => {
                tracing::error!("internal error: {err:#}");
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        let message = match &self {
            Self::Internal(_) => "Something went wrong".to_owned(),
            other => other.to_string(),
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

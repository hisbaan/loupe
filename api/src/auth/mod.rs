//! GitHub sign-in (GitHub App user-to-server OAuth) and session cookies.

mod handlers;
mod session;

use axum::{
    Router,
    routing::{get, post},
};

use crate::state::AppState;

pub use session::CurrentUser;

pub const SESSION_COOKIE: &str = "loupe_session";
pub const OAUTH_STATE_COOKIE: &str = "loupe_oauth_state";
pub const SESSION_TTL_SECS: i64 = 60 * 60 * 24 * 30;

/// Browser-facing OAuth routes, mounted at `/auth`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/github/login", get(handlers::login))
        .route("/github/callback", get(handlers::callback))
        .route("/logout", post(handlers::logout))
}

/// JSON routes, mounted at `/api`.
pub fn api_routes() -> Router<AppState> {
    Router::new().route("/me", get(handlers::me))
}

use axum::{
    Json,
    extract::{Query, State},
    response::{IntoResponse, Redirect},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};
use time::Duration;

use super::{CurrentUser, OAUTH_STATE_COOKIE, SESSION_COOKIE, SESSION_TTL_SECS};
use crate::{
    crypto::{random_token, sha256},
    error::{AppError, AppResult},
    github::{self, GitHubUser},
    state::AppState,
};

fn callback_url(state: &AppState) -> String {
    format!("{}/auth/github/callback", state.config.public_url)
}

fn cookie(state: &AppState, name: &'static str, value: String, max_age: Duration) -> Cookie<'static> {
    Cookie::build((name, value))
        .path("/")
        .http_only(true)
        .secure(state.config.secure_cookies())
        .same_site(SameSite::Lax)
        .max_age(max_age)
        .build()
}

pub async fn login(State(state): State<AppState>, jar: CookieJar) -> AppResult<impl IntoResponse> {
    let app = state.config.github()?;
    let oauth_state = random_token();
    let mut url = url::Url::parse("https://github.com/login/oauth/authorize").expect("static url");
    url.query_pairs_mut()
        .append_pair("client_id", &app.client_id)
        .append_pair("redirect_uri", &callback_url(&state))
        .append_pair("state", &oauth_state);

    let jar = jar.add(cookie(&state, OAUTH_STATE_COOKIE, oauth_state, Duration::minutes(10)));
    Ok((jar, Redirect::to(url.as_str())))
}

#[derive(Deserialize)]
pub struct CallbackParams {
    code: String,
    state: String,
}

pub async fn callback(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(params): Query<CallbackParams>,
) -> AppResult<impl IntoResponse> {
    let expected = jar.get(OAUTH_STATE_COOKIE).map(|c| c.value().to_owned());
    if expected.as_deref() != Some(params.state.as_str()) {
        return Err(AppError::BadRequest(
            "OAuth state mismatch, try signing in again".into(),
        ));
    }

    let tokens = github::exchange_code(&state, &params.code, &callback_url(&state)).await?;
    let gh_user: GitHubUser = github::get_json(&state, &tokens.access_token, "/user").await?;

    let user_id: i64 = sqlx::query_scalar(
        "INSERT INTO users (github_id, login, avatar_url) VALUES (?, ?, ?)
         ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url, updated_at = unixepoch()
         RETURNING id",
    )
    .bind(gh_user.id)
    .bind(&gh_user.login)
    .bind(&gh_user.avatar_url)
    .fetch_one(&state.db)
    .await?;
    github::store_tokens(&state, user_id, &tokens).await?;

    let session_token = random_token();
    sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, unixepoch() + ?)")
        .bind(sha256(&session_token))
        .bind(user_id)
        .bind(SESSION_TTL_SECS)
        .execute(&state.db)
        .await?;

    let jar = jar.remove(Cookie::build(OAUTH_STATE_COOKIE).path("/")).add(cookie(
        &state,
        SESSION_COOKIE,
        session_token,
        Duration::seconds(SESSION_TTL_SECS),
    ));
    Ok((jar, Redirect::to("/")))
}

pub async fn logout(State(state): State<AppState>, jar: CookieJar) -> AppResult<impl IntoResponse> {
    if let Some(session) = jar.get(SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(sha256(session.value()))
            .execute(&state.db)
            .await?;
    }
    Ok((jar.remove(Cookie::build(SESSION_COOKIE).path("/")), Redirect::to("/")))
}

#[derive(Serialize)]
pub struct MeResponse {
    login: String,
    avatar_url: Option<String>,
}

pub async fn me(user: CurrentUser) -> Json<MeResponse> {
    Json(MeResponse {
        login: user.login,
        avatar_url: user.avatar_url,
    })
}

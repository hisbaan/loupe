//! Refreshing Sign in with ChatGPT tokens on the browser's behalf.
//!
//! The browser keeps the refresh token in its vault. If `auth.openai.com`
//! doesn't allow cross-origin requests, the browser can't refresh by itself, so
//! the server relays: the refresh token passes through in memory and is never
//! stored or logged.

use anyhow::{Context, anyhow, bail};
use loupe_protocol::siwc::{RESOURCE, TokenResponse, Tokens};
use serde_json::Value;

/// Error the browser can act on by asking the user to sign in again.
#[derive(Debug, thiserror::Error)]
#[error("ChatGPT sign-in expired or was revoked")]
pub struct Expired;

pub async fn refresh(
    http: &reqwest::Client,
    token_url: &str,
    client_id: &str,
    refresh_token: &str,
) -> anyhow::Result<Tokens> {
    let response = http
        .post(token_url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", refresh_token),
            ("resource", RESOURCE),
        ])
        .send()
        .await
        .context("couldn't reach ChatGPT")?;

    let status = response.status();
    if !status.is_success() {
        let body: Value = response.json().await.unwrap_or(Value::Null);
        // OAuth reports a used, expired or revoked refresh token as invalid_grant.
        if status.is_client_error() && body["error"].as_str() == Some("invalid_grant") {
            return Err(Expired.into());
        }
        let message = body["error_description"]
            .as_str()
            .or(body["error"].as_str())
            .unwrap_or("");
        bail!("ChatGPT token refresh failed ({status}) {message}");
    }

    let response: TokenResponse = response.json().await.context("malformed token response")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs() as i64;
    Tokens::from_response(response, now).map_err(|e| anyhow!(e))
}

#[cfg(test)]
mod tests {
    use axum::{Form, Json, Router, http::StatusCode, routing::post};
    use serde_json::json;
    use std::collections::HashMap;

    use super::*;

    async fn mock() -> String {
        let app = Router::new().route(
            "/token",
            post(|Form(form): Form<HashMap<String, String>>| async move {
                assert_eq!(form["grant_type"], "refresh_token");
                assert_eq!(form["resource"], RESOURCE);
                match form["refresh_token"].as_str() {
                    "good" => (
                        StatusCode::OK,
                        Json(json!({
                            "access_token": "new-access",
                            "token_type": "Bearer",
                            "expires_in": 3600,
                            "scope": "openid offline_access chatgpt.tokens.use.direct",
                            "refresh_token": "new-refresh",
                        })),
                    ),
                    _ => (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid_grant" }))),
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/token")
    }

    #[tokio::test]
    async fn refreshes() {
        let url = mock().await;
        let tokens = refresh(&reqwest::Client::new(), &url, "oaiapp_x", "good")
            .await
            .unwrap();
        assert_eq!(tokens.access_token, "new-access");
        assert_eq!(tokens.refresh_token.as_deref(), Some("new-refresh"));
    }

    #[tokio::test]
    async fn reports_expired_grant() {
        let url = mock().await;
        let err = refresh(&reqwest::Client::new(), &url, "oaiapp_x", "used")
            .await
            .unwrap_err();
        assert!(err.is::<Expired>());
    }
}

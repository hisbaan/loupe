//! Sign in with ChatGPT token endpoint details shared by the gateway (code
//! exchange) and the server (refresh relay). Reference:
//! https://developers.openai.com/siwc/token-sharing-open-source/sign-in

use serde::{Deserialize, Serialize};

pub const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
/// The `resource` every authorize, exchange and refresh request names.
pub const RESOURCE: &str = "https://api.openai.com/v1";
/// Grants inference against the user's ChatGPT plan. Signing in alone doesn't.
pub const PLAN_USAGE_SCOPE: &str = "chatgpt.tokens.use.direct";

/// Successful response from [`TOKEN_URL`].
#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: i64,
    pub scope: String,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    /// Refresh tokens rotate: every refresh returns a new one and the old one
    /// stops working.
    pub refresh_token: Option<String>,
    /// Passed through for the client; nothing here consumes identity claims, so
    /// it isn't verified.
    pub id_token: Option<String>,
    /// Unix seconds.
    pub expires_at: i64,
    pub scope: String,
}

impl Tokens {
    /// Validates a token response. `now` is unix seconds.
    pub fn from_response(response: TokenResponse, now: i64) -> Result<Self, String> {
        if !response.token_type.eq_ignore_ascii_case("bearer") {
            return Err(format!("unexpected token type {}", response.token_type));
        }
        // The token response's scope is the authoritative check.
        if !response.scope.split_whitespace().any(|s| s == PLAN_USAGE_SCOPE) {
            return Err(format!(
                "ChatGPT didn't grant permission to use your plan (scopes: {})",
                response.scope
            ));
        }
        Ok(Self {
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            id_token: response.id_token,
            expires_at: now + response.expires_in,
            scope: response.scope,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(scope: &str) -> TokenResponse {
        TokenResponse {
            access_token: "a".into(),
            token_type: "Bearer".into(),
            expires_in: 3600,
            scope: scope.into(),
            refresh_token: Some("r".into()),
            id_token: None,
        }
    }

    #[test]
    fn requires_plan_scope() {
        assert!(Tokens::from_response(response("openid offline_access"), 0).is_err());
        let tokens = Tokens::from_response(response("openid chatgpt.tokens.use.direct"), 100).unwrap();
        assert_eq!(tokens.expires_at, 3700);
    }
}

//! Sign in with ChatGPT protocol details. Reference:
//! https://developers.openai.com/siwc/token-sharing-open-source/sign-in and
//! openai/sign-in-with-chatgpt-devkit `packages/local/src/oauth.ts`.

use anyhow::{Context, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::Url;

use crate::host::HostState;

pub const DEFAULT_PORT: u16 = 1455;
const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const REGISTRATION_CLIENT_ID: &str = "dynamic_agent_client";
const AGENT_NAME: &str = "Loupe";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_USAGE_SCOPE: &str = "chatgpt.tokens.use.direct";
pub const RESOURCE: &str = "https://api.openai.com/v1";

fn random_urlsafe() -> String {
    let bytes: [u8; 32] = rand::rng().random();
    URL_SAFE_NO_PAD.encode(bytes)
}

/// One sign-in attempt: PKCE verifier, state and nonce.
pub struct Attempt {
    pub state: String,
    nonce: String,
    code_verifier: String,
    pub redirect_uri: String,
    ext_agent_host_id: String,
    /// The already-issued client id, or `None` when this attempt registers.
    pub issued_client_id: Option<String>,
}

impl Attempt {
    pub fn new(host: &HostState, redirect_uri: &str) -> Self {
        Self {
            state: random_urlsafe(),
            nonce: random_urlsafe(),
            code_verifier: random_urlsafe(),
            redirect_uri: redirect_uri.to_owned(),
            ext_agent_host_id: host.ext_agent_host_id.clone(),
            issued_client_id: host.client_id.clone(),
        }
    }

    pub fn authorize_url(&self) -> Url {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(self.code_verifier.as_bytes()));
        let mut url = Url::parse(AUTHORIZE_URL).expect("static url");
        {
            let mut q = url.query_pairs_mut();
            match &self.issued_client_id {
                Some(client_id) => q.append_pair("client_id", client_id),
                None => q
                    .append_pair("client_id", REGISTRATION_CLIENT_ID)
                    .append_pair("agent_name_hint", AGENT_NAME),
            };
            q.append_pair("ext_agent_host_id", &self.ext_agent_host_id)
                .append_pair("response_type", "code")
                .append_pair("redirect_uri", &self.redirect_uri)
                .append_pair("scope", SCOPE)
                .append_pair("resource", RESOURCE)
                .append_pair("state", &self.state)
                .append_pair("nonce", &self.nonce)
                .append_pair("code_challenge_method", "S256")
                .append_pair("code_challenge", &challenge);
        }
        url
    }

    /// Exchange the authorization code. `client_id` is the issued id.
    pub async fn exchange(&self, client_id: &str, code: &str) -> anyhow::Result<Tokens> {
        let response = reqwest::Client::new()
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id),
                ("code", code),
                ("code_verifier", &self.code_verifier),
                ("redirect_uri", &self.redirect_uri),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .context("token request failed")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("token exchange failed ({status}): {body}");
        }
        Tokens::from_response(response.json().await?)
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: i64,
    scope: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
}

pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Passed through for the client; the gateway doesn't consume identity
    /// claims, so it doesn't verify the id token.
    pub id_token: Option<String>,
    pub expires_at: i64,
    pub scope: String,
}

impl Tokens {
    fn from_response(response: TokenResponse) -> anyhow::Result<Self> {
        if !response.token_type.eq_ignore_ascii_case("bearer") {
            bail!("unexpected token type {}", response.token_type);
        }
        // Signing in alone doesn't grant plan usage; the token response's
        // scope is the authoritative check.
        if !response.scope.split_whitespace().any(|s| s == PLAN_USAGE_SCOPE) {
            bail!(
                "ChatGPT didn't grant permission to use your plan (scopes: {})",
                response.scope
            );
        }
        if response.refresh_token.is_none() {
            bail!("ChatGPT didn't return a refresh token");
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs() as i64;
        Ok(Self {
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            id_token: response.id_token,
            expires_at: now + response.expires_in,
            scope: response.scope,
        })
    }
}

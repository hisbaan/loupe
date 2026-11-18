//! Payload the gateway hands to the web app after a successful
//! "Sign in with ChatGPT" exchange.
//!
//! The gateway redirects the browser to `{server}/connect#<payload>`, where
//! `<payload>` is base64url(JSON). URL fragments are never sent to the server,
//! so these tokens only ever exist on the user's machine and in their browser,
//! where they are encrypted into the passkey vault.

use serde::{Deserialize, Serialize};

pub const HANDOFF_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatGptHandoff {
    pub version: u32,
    /// The `client_id` issued by dynamic registration. Needed to refresh.
    pub client_id: String,
    /// Stable per-installation id sent as `ext_agent_host_id`.
    pub ext_agent_host_id: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    /// Unix seconds.
    pub expires_at: i64,
    pub scope: String,
}

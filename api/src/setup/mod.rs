//! First-run setup: creating Loupe's GitHub App with GitHub's app manifest
//! flow. Active only while `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are unset.
//!
//! Whoever completes setup owns the app, and the server may be reachable before
//! its admin gets there, so every step needs a one-time token that's only
//! printed to the server's log. The resulting credentials are shown once for
//! the admin to put in `.env`; nothing is stored.
//! https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest

use std::{collections::HashSet, sync::Mutex};

use axum::{Json, Router, extract::State, routing::get, routing::post};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    crypto::random_token,
    error::{AppError, AppResult},
    state::AppState,
    trust::valid_login,
};

/// GitHub's limit on app names.
const MAX_APP_NAME: usize = 34;

pub struct SetupState {
    token: String,
    /// Outstanding `state` values from manifests sent to GitHub.
    pending: Mutex<HashSet<String>>,
}

impl SetupState {
    pub fn new() -> Self {
        Self {
            token: random_token(),
            pending: Mutex::new(HashSet::new()),
        }
    }

    /// Printed to the server log at startup; it's the admin's proof of
    /// access, so (unlike credentials) it's meant to be logged.
    pub fn token(&self) -> &str {
        &self.token
    }

    fn check(&self, token: &str) -> AppResult<()> {
        // Compare digests so the comparison takes the same time either way.
        if Sha256::digest(token.trim().as_bytes()) == Sha256::digest(self.token.as_bytes()) {
            Ok(())
        } else {
            Err(AppError::BadRequest(
                "that setup token is wrong; copy it from the server log".into(),
            ))
        }
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/config", get(config))
        .route("/setup/manifest", post(manifest))
        .route("/setup/convert", post(convert))
}

#[derive(Serialize)]
struct ClientConfig {
    /// False while the server is waiting for setup.
    github_configured: bool,
    /// Where to install the GitHub App on more accounts and repositories.
    install_url: Option<String>,
}

/// Public facts the web app needs before anyone signs in.
async fn config(State(state): State<AppState>) -> Json<ClientConfig> {
    let app = state.config.github.as_ref();
    Json(ClientConfig {
        github_configured: app.is_some(),
        install_url: app
            .and_then(|a| a.slug.as_ref())
            .map(|slug| format!("https://github.com/apps/{slug}/installations/new")),
    })
}

fn setup(state: &AppState) -> AppResult<&SetupState> {
    state
        .setup
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Loupe is already connected to GitHub".into()))
}

#[derive(Deserialize)]
struct ManifestRequest {
    token: String,
    name: String,
    /// Create the app under this organization instead of the admin's account.
    organization: Option<String>,
    /// Whether other accounts and organizations can install the app.
    public: bool,
}

#[derive(Serialize)]
struct ManifestResponse {
    /// The browser POSTs a form with a `manifest` field here.
    action: String,
    manifest: String,
}

async fn manifest(
    State(state): State<AppState>,
    Json(body): Json<ManifestRequest>,
) -> AppResult<Json<ManifestResponse>> {
    let setup = setup(&state)?;
    setup.check(&body.token)?;
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > MAX_APP_NAME {
        return Err(AppError::BadRequest(format!(
            "the app name must be 1-{MAX_APP_NAME} characters"
        )));
    }
    let organization = body.organization.as_deref().map(str::trim).filter(|o| !o.is_empty());
    if organization.is_some_and(|o| !valid_login(o)) {
        return Err(AppError::BadRequest("that isn't a valid organization name".into()));
    }

    let public_url = &state.config.public_url;
    let manifest = json!({
        "name": name,
        "url": public_url,
        "redirect_url": format!("{public_url}/setup/callback"),
        "callback_urls": [format!("{public_url}/auth/github/callback")],
        "public": body.public,
        "request_oauth_on_install": false,
        // Read-only, and only what reviews need.
        "default_permissions": {
            "contents": "read",
            "pull_requests": "read",
            "metadata": "read",
        },
        "default_events": [],
    });

    let nonce = random_token();
    setup.pending.lock().expect("setup lock").insert(nonce.clone());
    let base = match organization {
        Some(org) => format!("https://github.com/organizations/{org}/settings/apps/new"),
        None => "https://github.com/settings/apps/new".to_owned(),
    };
    Ok(Json(ManifestResponse {
        action: format!("{base}?state={nonce}"),
        manifest: manifest.to_string(),
    }))
}

#[derive(Deserialize)]
struct ConvertRequest {
    token: String,
    code: String,
    state: String,
}

#[derive(Serialize)]
struct ConvertResponse {
    /// Lines for `.env`.
    env: String,
    app_url: String,
    install_url: String,
}

#[derive(Deserialize)]
struct Conversion {
    slug: String,
    client_id: String,
    client_secret: String,
    html_url: String,
}

/// Trades the code GitHub redirected back with for the new app's credentials.
async fn convert(State(state): State<AppState>, Json(body): Json<ConvertRequest>) -> AppResult<Json<ConvertResponse>> {
    let setup = setup(&state)?;
    setup.check(&body.token)?;
    if !setup.pending.lock().expect("setup lock").remove(&body.state) {
        return Err(AppError::BadRequest("this setup link has expired; start again".into()));
    }
    if body.code.is_empty() || !body.code.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(AppError::BadRequest("invalid code from GitHub".into()));
    }

    // The code is single-use and short-lived; no authentication needed.
    let response = state
        .http
        .post(format!(
            "https://api.github.com/app-manifests/{}/conversions",
            body.code
        ))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;
    if !response.status().is_success() {
        tracing::warn!(status = %response.status(), "GitHub app manifest conversion failed");
        return Err(AppError::BadRequest(
            "GitHub didn't accept the setup code; it may have expired. Start again".into(),
        ));
    }
    let app: Conversion = response.json().await?;
    Ok(Json(ConvertResponse {
        env: format!(
            "GITHUB_CLIENT_ID={}\nGITHUB_CLIENT_SECRET={}\nGITHUB_APP_SLUG={}\n",
            app.client_id, app.client_secret, app.slug
        ),
        install_url: format!("https://github.com/apps/{}/installations/new", app.slug),
        app_url: app.html_url,
    }))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;
    use crate::config::Config;

    async fn serve() -> (String, String) {
        let db = SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
        let config = Config {
            addr: String::new(),
            public_url: "https://loupe.example.com".into(),
            database_url: String::new(),
            web_dir: String::new(),
            secret_key: [0; 32],
            github: None,
            openai_base_url: String::new(),
        };
        let state = AppState::new(config, db);
        let token = state.setup.as_ref().unwrap().token().to_owned();
        let app = Router::new().nest("/api", routes()).with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}/api"), token)
    }

    #[tokio::test]
    async fn manifest_needs_the_setup_token() {
        let (base, token) = serve().await;
        let http = reqwest::Client::new();
        let post = |path: &str, body: Value| http.post(format!("{base}{path}")).json(&body).send();

        let config: Value = http
            .get(format!("{base}/config"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(config["github_configured"], false);

        let body = json!({ "token": "wrong", "name": "Loupe", "organization": null, "public": true });
        assert_eq!(post("/setup/manifest", body).await.unwrap().status(), 400);

        let body = json!({ "token": token, "name": "Loupe", "organization": "my-org", "public": false });
        let response: Value = post("/setup/manifest", body).await.unwrap().json().await.unwrap();
        let action = response["action"].as_str().unwrap();
        assert!(action.starts_with("https://github.com/organizations/my-org/settings/apps/new?state="));
        let manifest: Value = serde_json::from_str(response["manifest"].as_str().unwrap()).unwrap();
        assert_eq!(
            manifest["callback_urls"][0],
            "https://loupe.example.com/auth/github/callback"
        );
        assert_eq!(manifest["redirect_url"], "https://loupe.example.com/setup/callback");
        assert_eq!(manifest["default_permissions"]["contents"], "read");

        // A state that wasn't issued is refused before GitHub is contacted.
        let body = json!({ "token": token, "code": "abc123", "state": "forged" });
        assert_eq!(post("/setup/convert", body).await.unwrap().status(), 400);
    }
}

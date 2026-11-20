use anyhow::{Context, bail};
use base64::{Engine, engine::general_purpose::STANDARD};

#[derive(Clone)]
pub struct GitHubApp {
    pub client_id: String,
    pub client_secret: String,
    /// The app's URL name, for "install the app" links.
    pub slug: Option<String>,
}

#[derive(Clone)]
pub struct Config {
    pub addr: String,
    /// Origin users reach Loupe at, e.g. `https://loupe.example.com`. In dev this
    /// is the Vite server, which proxies `/api` and `/auth` to us.
    pub public_url: String,
    pub database_url: String,
    pub web_dir: String,
    pub secret_key: [u8; 32],
    /// `None` until the GitHub App exists; the server then runs in setup mode
    /// (`/setup`) so an admin can create one.
    pub github: Option<GitHubApp>,
    /// Override for tests or OpenAI-compatible proxies.
    pub openai_base_url: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let secret_key = STANDARD
            .decode(required("LOUPE_SECRET_KEY")?)
            .context("LOUPE_SECRET_KEY must be base64")?;
        let Ok(secret_key) = <[u8; 32]>::try_from(secret_key) else {
            bail!("LOUPE_SECRET_KEY must decode to exactly 32 bytes (openssl rand -base64 32)");
        };

        Ok(Self {
            addr: optional("LOUPE_ADDR", "0.0.0.0:3000"),
            // No default: a wrong one silently breaks GitHub sign-in and cookies.
            public_url: required("LOUPE_PUBLIC_URL")?
                .trim_end_matches('/')
                .to_owned(),
            database_url: optional("LOUPE_DATABASE_URL", "sqlite://loupe.db"),
            web_dir: optional("LOUPE_WEB_DIR", "../web/dist"),
            secret_key,
            github: match (non_empty("GITHUB_CLIENT_ID"), non_empty("GITHUB_CLIENT_SECRET")) {
                (Some(client_id), Some(client_secret)) => Some(GitHubApp {
                    client_id,
                    client_secret,
                    slug: non_empty("GITHUB_APP_SLUG"),
                }),
                (None, None) => None,
                _ => bail!("set both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or neither to run setup"),
            },
            openai_base_url: optional("LOUPE_OPENAI_BASE_URL", crate::inference::DEFAULT_BASE_URL)
                .trim_end_matches('/')
                .to_owned(),
        })
    }

    /// The GitHub App, or an error explaining that setup hasn't happened yet.
    pub fn github(&self) -> crate::error::AppResult<&GitHubApp> {
        self.github.as_ref().ok_or(crate::error::AppError::NotConfigured)
    }

    pub fn secure_cookies(&self) -> bool {
        self.public_url.starts_with("https://")
    }
}

fn required(key: &str) -> anyhow::Result<String> {
    std::env::var(key).with_context(|| format!("{key} is not set"))
}

fn non_empty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

fn optional(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}

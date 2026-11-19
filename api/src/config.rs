use anyhow::{Context, bail};
use base64::{Engine, engine::general_purpose::STANDARD};

#[derive(Clone)]
pub struct Config {
    pub addr: String,
    /// Origin users reach Loupe at, e.g. `https://loupe.example.com`. In dev this
    /// is the Vite server, which proxies `/api` and `/auth` to us.
    pub public_url: String,
    pub database_url: String,
    pub web_dir: String,
    pub secret_key: [u8; 32],
    pub github_client_id: String,
    pub github_client_secret: String,
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
            public_url: optional("LOUPE_PUBLIC_URL", "http://localhost:5173")
                .trim_end_matches('/')
                .to_owned(),
            database_url: optional("LOUPE_DATABASE_URL", "sqlite://loupe.db"),
            web_dir: optional("LOUPE_WEB_DIR", "../web/dist"),
            secret_key,
            github_client_id: required("GITHUB_CLIENT_ID")?,
            github_client_secret: required("GITHUB_CLIENT_SECRET")?,
            openai_base_url: optional("LOUPE_OPENAI_BASE_URL", crate::inference::DEFAULT_BASE_URL)
                .trim_end_matches('/')
                .to_owned(),
        })
    }

    pub fn secure_cookies(&self) -> bool {
        self.public_url.starts_with("https://")
    }
}

fn required(key: &str) -> anyhow::Result<String> {
    std::env::var(key).with_context(|| format!("{key} is not set"))
}

fn optional(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}

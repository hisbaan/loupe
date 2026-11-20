use std::sync::Arc;

use sqlx::SqlitePool;

use crate::{config::Config, crypto::Cipher, setup::SetupState};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: SqlitePool,
    pub cipher: Arc<Cipher>,
    pub http: reqwest::Client,
    /// Present while the GitHub App hasn't been configured.
    pub setup: Option<Arc<SetupState>>,
}

impl AppState {
    pub fn new(config: Config, db: SqlitePool) -> Self {
        let cipher = Cipher::new(&config.secret_key);
        let http = reqwest::Client::builder()
            .user_agent(concat!("loupe/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client");
        let setup = config.github.is_none().then(|| Arc::new(SetupState::new()));
        Self {
            setup,
            config: Arc::new(config),
            db,
            cipher: Arc::new(cipher),
            http,
        }
    }
}

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::{config::Config, crypto::Cipher};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: SqlitePool,
    pub cipher: Arc<Cipher>,
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(config: Config, db: SqlitePool) -> Self {
        let cipher = Cipher::new(&config.secret_key);
        let http = reqwest::Client::builder()
            .user_agent(concat!("loupe/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client");
        Self {
            config: Arc::new(config),
            db,
            cipher: Arc::new(cipher),
            http,
        }
    }
}

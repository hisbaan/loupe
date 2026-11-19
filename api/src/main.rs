mod auth;
mod config;
mod crypto;
mod error;
mod github;
mod inference;
mod prepass;
mod pulls;
mod reviews;
mod state;
mod vault;

use std::path::Path;

use axum::{Router, routing::get};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing_subscriber::EnvFilter;

use crate::{config::Config, state::AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "loupe_api=info,tower_http=info".into()))
        .init();

    let config = Config::from_env()?;

    let db_options: SqliteConnectOptions = config.database_url.parse()?;
    let db = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(
            db_options
                .create_if_missing(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                .foreign_keys(true),
        )
        .await?;
    sqlx::migrate!("./migrations").run(&db).await?;

    let state = AppState::new(config.clone(), db);

    let api = Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(auth::api_routes())
        .merge(pulls::routes())
        .merge(reviews::routes())
        .merge(inference::routes())
        .merge(vault::routes());

    let index = Path::new(&config.web_dir).join("index.html");
    let app = Router::new()
        .nest("/api", api)
        .nest("/auth", auth::routes())
        .fallback_service(ServeDir::new(&config.web_dir).fallback(ServeFile::new(index)))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&config.addr).await?;
    tracing::info!("listening on {}", config.addr);
    axum::serve(listener, app).await?;
    Ok(())
}

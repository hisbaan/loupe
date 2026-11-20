//! Inference credential vault storage. The browser encrypts everything with
//! keys derived from a passkey (WebAuthn PRF) or a passphrase; this module only
//! stores opaque bytes for the signed-in user. Session cookies gate access, but
//! the server couldn't decrypt the vault even if it wanted to, so passkey
//! assertions aren't verified here.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};

use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    state::AppState,
};

const MAX_CIPHERTEXT: usize = 64 * 1024;
const MAX_KEYS: i64 = 10;
/// OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256.
const MIN_PBKDF2_ITERATIONS: i64 = 600_000;
const MAX_PBKDF2_ITERATIONS: i64 = 10_000_000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/vault",
            get(get_vault).post(create_vault).put(update_vault).delete(delete_vault),
        )
        .route("/vault/keys", axum::routing::post(add_key))
        .route("/vault/keys/{id}", delete(remove_key))
}

/// Binary fields travel as unpadded base64url.
mod b64 {
    use super::*;

    pub fn serialize<S: serde::Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&URL_SAFE_NO_PAD.encode(bytes))
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        URL_SAFE_NO_PAD.decode(s).map_err(serde::de::Error::custom)
    }

    pub fn serialize_option<S: serde::Serializer>(bytes: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(bytes) => serialize(bytes, s),
            None => s.serialize_none(),
        }
    }
}

#[derive(Serialize)]
struct Vault {
    version: i64,
    #[serde(with = "b64")]
    ciphertext: Vec<u8>,
    keys: Vec<VaultKey>,
}

#[derive(Serialize, sqlx::FromRow)]
struct VaultKey {
    id: i64,
    kind: String,
    label: String,
    #[serde(serialize_with = "b64::serialize_option")]
    credential_id: Option<Vec<u8>>,
    #[serde(with = "b64")]
    salt: Vec<u8>,
    iterations: Option<i64>,
    #[serde(with = "b64")]
    wrapped_key: Vec<u8>,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum NewKey {
    Passkey {
        label: String,
        #[serde(with = "b64")]
        credential_id: Vec<u8>,
        #[serde(with = "b64")]
        salt: Vec<u8>,
        #[serde(with = "b64")]
        wrapped_key: Vec<u8>,
    },
    Passphrase {
        label: String,
        #[serde(with = "b64")]
        salt: Vec<u8>,
        iterations: i64,
        #[serde(with = "b64")]
        wrapped_key: Vec<u8>,
    },
}

impl NewKey {
    fn validate(&self) -> AppResult<()> {
        let (label, salt, wrapped_key) = match self {
            Self::Passkey {
                label,
                credential_id,
                salt,
                wrapped_key,
            } => {
                check(
                    !credential_id.is_empty() && credential_id.len() <= 1023,
                    "invalid credential id",
                )?;
                (label, salt, wrapped_key)
            }
            Self::Passphrase {
                label,
                salt,
                iterations,
                wrapped_key,
            } => {
                check(
                    (MIN_PBKDF2_ITERATIONS..=MAX_PBKDF2_ITERATIONS).contains(iterations),
                    "passphrase iteration count out of range",
                )?;
                (label, salt, wrapped_key)
            }
        };
        check(
            !label.trim().is_empty() && label.chars().count() <= 100,
            "label must be 1-100 characters",
        )?;
        check((16..=64).contains(&salt.len()), "salt must be 16-64 bytes")?;
        // A 32-byte key, a 12-byte IV and a 16-byte tag, with room to change.
        check((32..=256).contains(&wrapped_key.len()), "invalid wrapped key")
    }

    async fn insert(&self, db: impl sqlx::SqliteExecutor<'_>, user_id: i64) -> AppResult<VaultKey> {
        let (kind, label, credential_id, salt, iterations, wrapped_key) = match self {
            Self::Passkey {
                label,
                credential_id,
                salt,
                wrapped_key,
            } => ("passkey", label, Some(credential_id), salt, None, wrapped_key),
            Self::Passphrase {
                label,
                salt,
                iterations,
                wrapped_key,
            } => ("passphrase", label, None, salt, Some(*iterations), wrapped_key),
        };
        Ok(sqlx::query_as(
            "INSERT INTO vault_keys (user_id, kind, label, credential_id, salt, iterations, wrapped_key)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             RETURNING id, kind, label, credential_id, salt, iterations, wrapped_key, created_at",
        )
        .bind(user_id)
        .bind(kind)
        .bind(label.trim())
        .bind(credential_id)
        .bind(salt)
        .bind(iterations)
        .bind(wrapped_key)
        .fetch_one(db)
        .await?)
    }
}

fn check(ok: bool, message: &str) -> AppResult<()> {
    if ok {
        Ok(())
    } else {
        Err(AppError::BadRequest(message.to_owned()))
    }
}

fn check_ciphertext(ciphertext: &[u8]) -> AppResult<()> {
    check(
        !ciphertext.is_empty() && ciphertext.len() <= MAX_CIPHERTEXT,
        "vault ciphertext is empty or too large",
    )
}

async fn load(db: &sqlx::SqlitePool, user_id: i64) -> AppResult<Option<Vault>> {
    let Some((version, ciphertext)) =
        sqlx::query_as::<_, (i64, Vec<u8>)>("SELECT version, ciphertext FROM vaults WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(db)
            .await?
    else {
        return Ok(None);
    };
    let keys = sqlx::query_as(
        "SELECT id, kind, label, credential_id, salt, iterations, wrapped_key, created_at
         FROM vault_keys WHERE user_id = ? ORDER BY id",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(Some(Vault {
        version,
        ciphertext,
        keys,
    }))
}

#[derive(Serialize)]
struct VaultResponse {
    vault: Option<Vault>,
}

async fn get_vault(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<VaultResponse>> {
    Ok(Json(VaultResponse {
        vault: load(&state.db, user.id).await?,
    }))
}

#[derive(Deserialize)]
struct CreateVault {
    #[serde(with = "b64")]
    ciphertext: Vec<u8>,
    key: NewKey,
}

async fn create_vault(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateVault>,
) -> AppResult<(StatusCode, Json<VaultResponse>)> {
    check_ciphertext(&body.ciphertext)?;
    body.key.validate()?;

    let mut tx = state.db.begin().await?;
    let created =
        sqlx::query("INSERT INTO vaults (user_id, version, ciphertext) VALUES (?, 1, ?) ON CONFLICT DO NOTHING")
            .bind(user.id)
            .bind(&body.ciphertext)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    if created == 0 {
        return Err(AppError::Conflict("a vault already exists".into()));
    }
    body.key.insert(&mut *tx, user.id).await?;
    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(VaultResponse {
            vault: load(&state.db, user.id).await?,
        }),
    ))
}

#[derive(Deserialize)]
struct UpdateVault {
    /// The version the client decrypted and modified.
    version: i64,
    #[serde(with = "b64")]
    ciphertext: Vec<u8>,
}

#[derive(Serialize)]
struct Version {
    version: i64,
}

async fn update_vault(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<UpdateVault>,
) -> AppResult<Json<Version>> {
    check_ciphertext(&body.ciphertext)?;
    let version: Option<i64> = sqlx::query_scalar(
        "UPDATE vaults SET version = version + 1, ciphertext = ?, updated_at = unixepoch()
         WHERE user_id = ? AND version = ? RETURNING version",
    )
    .bind(&body.ciphertext)
    .bind(user.id)
    .bind(body.version)
    .fetch_optional(&state.db)
    .await?;
    match version {
        Some(version) => Ok(Json(Version { version })),
        None => Err(AppError::Conflict("the vault changed since it was read".into())),
    }
}

async fn delete_vault(State(state): State<AppState>, user: CurrentUser) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM vaults WHERE user_id = ?")
        .bind(user.id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn add_key(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(key): Json<NewKey>,
) -> AppResult<(StatusCode, Json<VaultKey>)> {
    key.validate()?;
    let mut tx = state.db.begin().await?;
    let count: Option<i64> = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM vault_keys WHERE user_id = v.user_id) FROM vaults v WHERE v.user_id = ?",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    match count {
        None => return Err(AppError::NotFound),
        Some(n) if n >= MAX_KEYS => {
            return Err(AppError::BadRequest(format!(
                "a vault can have at most {MAX_KEYS} keys"
            )));
        }
        Some(_) => {}
    }
    let key = key.insert(&mut *tx, user.id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(key)))
}

async fn remove_key(State(state): State<AppState>, user: CurrentUser, Path(id): Path<i64>) -> AppResult<StatusCode> {
    // Removing the last key would leave a vault nobody can open.
    let removed = sqlx::query(
        "DELETE FROM vault_keys WHERE id = ? AND user_id = ?
         AND (SELECT COUNT(*) FROM vault_keys WHERE user_id = ?) > 1",
    )
    .bind(id)
    .bind(user.id)
    .bind(user.id)
    .execute(&state.db)
    .await?
    .rows_affected();
    if removed == 1 {
        return Ok(StatusCode::NO_CONTENT);
    }
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM vault_keys WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .fetch_optional(&state.db)
        .await?;
    match exists {
        Some(_) => Err(AppError::BadRequest("can't remove the vault's only key".into())),
        None => Err(AppError::NotFound),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;
    use crate::{auth::SESSION_COOKIE, config::Config, crypto::sha256};

    struct Client {
        base: String,
        http: reqwest::Client,
    }

    impl Client {
        async fn send(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> (u16, Value) {
            let mut request = self
                .http
                .request(method, format!("{}/api{path}", self.base))
                .header("cookie", format!("{SESSION_COOKIE}=session"));
            if let Some(body) = body {
                request = request.json(&body);
            }
            let response = request.send().await.unwrap();
            let status = response.status().as_u16();
            (status, response.json().await.unwrap_or(Value::Null))
        }
    }

    async fn serve() -> Client {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        sqlx::query("INSERT INTO users (id, github_id, login) VALUES (1, 1, 'me')")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, unixepoch() + 60)")
            .bind(sha256("session"))
            .execute(&db)
            .await
            .unwrap();
        let config = Config {
            addr: String::new(),
            public_url: String::new(),
            database_url: String::new(),
            web_dir: String::new(),
            secret_key: [0; 32],
            github: None,
            openai_base_url: String::new(),
        };
        let app = Router::new()
            .nest("/api", routes())
            .with_state(AppState::new(config, db));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Client {
            base: format!("http://{addr}"),
            http: reqwest::Client::new(),
        }
    }

    fn b64(len: usize) -> String {
        URL_SAFE_NO_PAD.encode(vec![7u8; len])
    }

    fn passkey() -> Value {
        json!({ "kind": "passkey", "label": "Laptop", "credential_id": b64(16), "salt": b64(32), "wrapped_key": b64(60) })
    }

    #[tokio::test]
    async fn create_update_and_keys() {
        use reqwest::Method;
        let client = serve().await;

        assert_eq!(
            client.send(Method::GET, "/vault", None).await.1,
            json!({ "vault": null })
        );

        let create = json!({ "ciphertext": b64(100), "key": passkey() });
        let (status, body) = client.send(Method::POST, "/vault", Some(create.clone())).await;
        assert_eq!(status, 201);
        assert_eq!(body["vault"]["version"], 1);
        let first_key = body["vault"]["keys"][0]["id"].as_i64().unwrap();
        assert_eq!(client.send(Method::POST, "/vault", Some(create)).await.0, 409);

        // Compare-and-swap: a write based on a stale version is refused.
        let update = |version| Some(json!({ "version": version, "ciphertext": b64(120) }));
        assert_eq!(client.send(Method::PUT, "/vault", update(1)).await.1["version"], 2);
        assert_eq!(client.send(Method::PUT, "/vault", update(1)).await.0, 409);

        // The only key can't be removed; once there's a second, it can.
        let path = format!("/vault/keys/{first_key}");
        assert_eq!(client.send(Method::DELETE, &path, None).await.0, 400);
        let weak = json!({ "kind": "passphrase", "label": "Backup", "salt": b64(16), "iterations": 1000, "wrapped_key": b64(60) });
        assert_eq!(client.send(Method::POST, "/vault/keys", Some(weak)).await.0, 400);
        let backup = json!({ "kind": "passphrase", "label": "Backup", "salt": b64(16), "iterations": 600000, "wrapped_key": b64(60) });
        assert_eq!(client.send(Method::POST, "/vault/keys", Some(backup)).await.0, 201);
        assert_eq!(client.send(Method::DELETE, &path, None).await.0, 204);
        assert_eq!(client.send(Method::DELETE, &path, None).await.0, 404);

        assert_eq!(client.send(Method::DELETE, "/vault", None).await.0, 204);
        assert_eq!(
            client.send(Method::GET, "/vault", None).await.1,
            json!({ "vault": null })
        );
    }
}

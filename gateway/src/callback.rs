//! The loopback listener that receives the OAuth callback.

use std::{collections::HashMap, sync::Arc};

use anyhow::{anyhow, bail};
use axum::{
    Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
};
use tokio::sync::{Mutex, oneshot};
use url::Url;

use crate::{handoff_fragment, host::HostState, new_handoff, siwc::Attempt};

pub struct Outcome {
    pub scope: String,
}

struct Shared {
    port: u16,
    attempt: Attempt,
    host: Mutex<HostState>,
    connect_url: Url,
    done: Mutex<Option<oneshot::Sender<anyhow::Result<Outcome>>>>,
}

pub async fn serve(
    listener: tokio::net::TcpListener,
    port: u16,
    attempt: Attempt,
    host: HostState,
    connect_url: Url,
) -> anyhow::Result<Outcome> {
    let (tx, rx) = oneshot::channel();
    let shared = Arc::new(Shared {
        port,
        attempt,
        host: Mutex::new(host),
        connect_url,
        done: Mutex::new(Some(tx)),
    });

    let app = Router::new()
        .route("/auth/callback", get(handle))
        .with_state(shared.clone());
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await
    });

    let result = rx.await.map_err(|_| anyhow!("callback listener stopped"))?;
    let _ = stop_tx.send(());
    let _ = server.await;
    result
}

async fn handle(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    // Reject DNS-rebinding style requests that reach us under another name.
    let expected_host = format!("127.0.0.1:{}", shared.port);
    if headers.get(header::HOST).and_then(|h| h.to_str().ok()) != Some(expected_host.as_str()) {
        return (StatusCode::BAD_REQUEST, "unexpected Host").into_response();
    }
    // A mismatched state is someone else's request: answer it without
    // consuming this attempt.
    if params.get("state") != Some(&shared.attempt.state) {
        return (StatusCode::BAD_REQUEST, "state mismatch").into_response();
    }

    let result = complete(&shared, &params).await;
    let response = match &result {
        Ok((_, fragment)) => {
            let mut target = shared.connect_url.clone();
            target.set_fragment(Some(fragment));
            Redirect::to(target.as_str()).into_response()
        }
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Html(format!(
                "<h1>Sign-in failed</h1><p>{}</p><p>You can close this tab.</p>",
                html_escape(&err.to_string())
            )),
        )
            .into_response(),
    };

    if let Some(tx) = shared.done.lock().await.take() {
        let _ = tx.send(result.map(|(outcome, _)| outcome));
    }
    response
}

async fn complete(shared: &Shared, params: &HashMap<String, String>) -> anyhow::Result<(Outcome, String)> {
    if let Some(error) = params.get("error") {
        bail!("ChatGPT returned an error: {error}");
    }
    let code = params
        .get("code")
        .ok_or_else(|| anyhow!("callback is missing the authorization code"))?;

    let mut host = shared.host.lock().await;
    let client_id = match (&shared.attempt.issued_client_id, params.get("client_id")) {
        (Some(saved), Some(returned)) if saved != returned => {
            bail!("ChatGPT returned a different client id than this machine registered")
        }
        (Some(saved), _) => saved.clone(),
        (None, Some(issued)) => {
            // Persist before the exchange so a failed exchange doesn't make the
            // next attempt register a second client.
            host.client_id = Some(issued.clone());
            host.save()?;
            issued.clone()
        }
        (None, None) => bail!("ChatGPT didn't issue a client id for this machine"),
    };

    let tokens = shared.attempt.exchange(&client_id, code).await?;
    let scope = tokens.scope.clone();
    let handoff = new_handoff(&host, client_id, tokens);
    Ok((Outcome { scope }, handoff_fragment(&handoff)))
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

//! `loupe-gateway`: runs on your own machine and performs the "Sign in with
//! ChatGPT" OAuth flow, which requires a loopback redirect. The resulting
//! tokens are handed to the Loupe web app in a URL fragment, so they never pass
//! through the Loupe server.

mod callback;
mod host;
mod siwc;

use anyhow::{Context, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use clap::{Parser, Subcommand};
use loupe_protocol::handoff::{ChatGptHandoff, HANDOFF_VERSION};
use url::Url;

#[derive(Parser)]
#[command(version, about = "Local sign-in gateway for Loupe")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Sign in with ChatGPT and hand the credentials to a Loupe server.
    Login {
        /// The Loupe web app, e.g. https://loupe.example.com
        #[arg(long, env = "LOUPE_SERVER")]
        server: Url,
        /// Loopback port for the OAuth callback. Only the port may change
        /// between sign-ins.
        #[arg(long, default_value_t = siwc::DEFAULT_PORT)]
        port: u16,
        /// Don't try to open a browser; just print the URL.
        #[arg(long)]
        no_browser: bool,
    },
    /// Forget this machine's registration (issued client id and host id).
    Reset,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Command::Login {
            server,
            port,
            no_browser,
        } => login(server, port, no_browser).await,
        Command::Reset => {
            host::HostState::reset()?;
            println!("Registration removed. The next login registers this machine again.");
            Ok(())
        }
    }
}

async fn login(server: Url, port: u16, no_browser: bool) -> anyhow::Result<()> {
    let connect_url = connect_url(&server)?;
    let host = host::HostState::load_or_create()?;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .with_context(|| format!("could not listen on 127.0.0.1:{port}; is another sign-in running?"))?;
    let redirect_uri = format!("http://127.0.0.1:{port}/auth/callback");
    let attempt = siwc::Attempt::new(&host, &redirect_uri);

    let authorize_url = attempt.authorize_url();
    println!("Opening your browser to sign in with ChatGPT. If it doesn't open, visit:\n\n  {authorize_url}\n");
    if !no_browser && webbrowser::open(authorize_url.as_str()).is_err() {
        eprintln!("Couldn't open a browser automatically.");
    }

    let outcome = callback::serve(listener, port, attempt, host, connect_url).await?;
    // Never print tokens.
    println!(
        "Signed in (scopes: {}). Finish connecting in your browser.",
        outcome.scope
    );
    Ok(())
}

/// The `/connect` page on the Loupe server, refusing plaintext origins other
/// than localhost: a page served over http could be tampered with to read the
/// fragment.
fn connect_url(server: &Url) -> anyhow::Result<Url> {
    let local = matches!(server.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if server.scheme() != "https" && !local {
        bail!("--server must use https (got {server})");
    }
    Ok(server.join("/connect")?)
}

pub fn handoff_fragment(handoff: &ChatGptHandoff) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(handoff).expect("handoff serializes"))
}

pub fn new_handoff(host: &host::HostState, client_id: String, tokens: siwc::Tokens) -> ChatGptHandoff {
    ChatGptHandoff {
        version: HANDOFF_VERSION,
        client_id,
        ext_agent_host_id: host.ext_agent_host_id.clone(),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
        expires_at: tokens.expires_at,
        scope: tokens.scope,
    }
}

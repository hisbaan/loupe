//! Plumbing shared by every kind of generated review: streaming progress to
//! the browser over SSE, and the model loop with read-only repository tools.

use std::{convert::Infallible, future::Future, time::Duration};

use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::Stream;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_stream::{StreamExt, wrappers::ReceiverStream};

use super::tools::{self, Toolbox};
use crate::{
    error::AppError,
    inference::{self, Credential},
    source::Source,
    state::AppState,
};

/// Model turns per review, including the final answer.
const MAX_TURNS: usize = 10;

/// Sends progress events to the browser. Every event is JSON with a `type`:
/// `status`, `generating`, `done` or `error`.
pub struct Reporter {
    tx: mpsc::Sender<String>,
    last_chars: std::sync::atomic::AtomicUsize,
}

impl Reporter {
    pub async fn status(&self, message: &str) {
        let _ = self
            .tx
            .send(json!({ "type": "status", "message": message }).to_string())
            .await;
    }

    /// Best-effort, at most every 500 characters; dropped if the browser is
    /// slow or gone.
    fn generating(&self, chars: usize) {
        use std::sync::atomic::Ordering;
        let last = self.last_chars.load(Ordering::Relaxed);
        if chars < last || chars - last >= 500 {
            self.last_chars.store(chars, Ordering::Relaxed);
            let _ = self
                .tx
                .try_send(json!({ "type": "generating", "chars": chars }).to_string());
        }
    }
}

/// Runs `job` in its own task and streams its progress. The task keeps going
/// if the browser disconnects, so results are still saved.
pub fn stream<R, F>(job: impl FnOnce(Reporter) -> F) -> Sse<impl Stream<Item = Result<Event, Infallible>>>
where
    R: Serialize,
    F: Future<Output = Result<R, String>> + Send + 'static,
{
    let (tx, rx) = mpsc::channel(32);
    let future = job(Reporter {
        tx: tx.clone(),
        last_chars: Default::default(),
    });
    tokio::spawn(async move {
        let event = match future.await {
            Ok(record) => json!({ "type": "done", "record": record }),
            Err(message) => json!({ "type": "error", "message": message }),
        };
        let _ = tx.send(event.to_string()).await;
    });
    let events = ReceiverStream::new(rx).map(|data| Ok(Event::default().data(data)));
    Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

/// A message safe to show the user; internal details are logged instead.
pub fn user_error(err: AppError) -> String {
    match err {
        AppError::Internal(_) => {
            tracing::error!("review job failed: {err:#}");
            "Something went wrong".to_owned()
        }
        other => other.to_string(),
    }
}

/// One structured-output generation, possibly over several turns of tool use.
pub struct Generation<'a> {
    pub state: &'a AppState,
    pub credential: &'a Credential,
    pub model: &'a str,
    pub reporter: &'a Reporter,
    pub instructions: &'a str,
    /// The prompt's random delimiter; tool output is wrapped in it.
    pub tag: &'a str,
    pub input: &'a str,
    pub schema_name: &'a str,
    pub schema: Value,
    /// `None` runs without tools.
    pub toolbox: Option<Toolbox<Source>>,
}

impl Generation<'_> {
    /// Returns the model's final JSON text.
    pub async fn run(mut self) -> Result<String, String> {
        let definitions = if self.toolbox.is_some() {
            tools::definitions()
        } else {
            Vec::new()
        };
        let mut input = vec![inference::user_message(self.input)];

        for turn_number in 1..=MAX_TURNS {
            self.reporter.status("Generating").await;
            let exhausted = self.toolbox.as_ref().is_none_or(Toolbox::exhausted);
            let turn = inference::respond(
                &self.state.http,
                &self.state.config.openai_base_url,
                self.credential,
                inference::Request {
                    model: self.model,
                    instructions: self.instructions,
                    input: &input,
                    schema_name: self.schema_name,
                    schema: self.schema.clone(),
                    tools: &definitions,
                    forbid_tools: exhausted || turn_number == MAX_TURNS,
                },
                |chars| self.reporter.generating(chars),
            )
            .await
            .map_err(|err| format!("{err:#}"))?;

            let calls: Vec<_> = turn.function_calls().collect();
            if calls.is_empty() {
                return Ok(turn.text);
            }
            let Some(toolbox) = self.toolbox.as_mut() else {
                return Err("The model asked for tools that weren't offered.".into());
            };
            let mut outputs = Vec::with_capacity(calls.len());
            for call in calls {
                self.reporter
                    .status(&Toolbox::<Source>::describe(call.name, call.arguments))
                    .await;
                let result = toolbox.call(call.name, call.arguments).await;
                // Repository content is as untrusted as the diff.
                let wrapped = format!("<{tag}>\n{result}\n</{tag}>", tag = self.tag);
                outputs.push(inference::function_output(call.call_id, wrapped));
            }
            input.extend(turn.items.iter().cloned());
            input.extend(outputs);
        }
        Err("The model kept calling tools without finishing.".into())
    }
}

//! Plumbing shared by every kind of generated review: streaming progress to
//! the browser over SSE, and the model loop with read-only repository tools.

use std::{convert::Infallible, future::Future, time::Duration};

use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::Stream;
use serde::{Deserialize, Serialize};
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

/// How hard a generation works: the model's reasoning effort, how much of the
/// repository it may read, and how many turns it gets.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effort {
    Quick,
    #[default]
    Standard,
    Thorough,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Quick => "quick",
            Self::Standard => "standard",
            Self::Thorough => "thorough",
        }
    }

    /// The Responses API's `reasoning.effort`.
    fn reasoning(self) -> &'static str {
        match self {
            Self::Quick => "low",
            Self::Standard => "medium",
            Self::Thorough => "high",
        }
    }

    /// Every tool round resends the whole conversation, so output is capped too.
    pub fn budget(self) -> tools::Budget {
        let (calls, output_bytes) = match self {
            Self::Quick => (8, 60_000),
            Self::Standard => (25, 150_000),
            Self::Thorough => (50, 250_000),
        };
        tools::Budget { calls, output_bytes }
    }

    /// Model turns, including the final answer.
    fn max_turns(self) -> usize {
        match self {
            Self::Quick => 5,
            Self::Standard => 10,
            Self::Thorough => 16,
        }
    }
}

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
    pub effort: Effort,
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

/// What a generation produced.
pub struct Output {
    /// The model's final JSON text.
    pub text: String,
    /// Repository files the model read, for provenance.
    pub files_read: Vec<String>,
}

impl Generation<'_> {
    pub async fn run(mut self) -> Result<Output, String> {
        let definitions = if self.toolbox.is_some() {
            tools::definitions()
        } else {
            Vec::new()
        };
        let mut input = vec![inference::user_message(self.input)];

        let max_turns = self.effort.max_turns();
        for turn_number in 1..=max_turns {
            self.reporter.status("Generating").await;
            let exhausted = self.toolbox.as_ref().is_none_or(Toolbox::exhausted);
            let turn = inference::respond(
                &self.state.http,
                &self.state.config.openai_base_url,
                self.credential,
                inference::Request {
                    model: self.model,
                    reasoning_effort: self.effort.reasoning(),
                    instructions: self.instructions,
                    input: &input,
                    schema_name: self.schema_name,
                    schema: self.schema.clone(),
                    tools: &definitions,
                    forbid_tools: exhausted || turn_number == max_turns,
                },
                |chars| self.reporter.generating(chars),
            )
            .await
            .map_err(|err| format!("{err:#}"))?;

            let calls: Vec<_> = turn.function_calls().collect();
            if calls.is_empty() {
                return Ok(Output {
                    text: turn.text,
                    files_read: self.toolbox.map(Toolbox::files_read).unwrap_or_default(),
                });
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

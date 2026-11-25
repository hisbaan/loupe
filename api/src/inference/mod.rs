//! Model calls over the OpenAI Responses API.
//!
//! Both credential kinds (a pasted API key, or a ChatGPT access token from the
//! gateway) are bearer tokens for the same endpoint. Requests always use
//! `store: false` and `stream: true`, which Sign in with ChatGPT requires.
//!
//! Credentials arrive with each request and live only in memory for the
//! duration of the job. Never log them. Also serves the model list and the
//! ChatGPT refresh relay (`routes`).

mod chatgpt;
mod routes;
mod sse;

pub use routes::routes;

use anyhow::{Context, anyhow, bail};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Credential {
    ApiKey { token: String },
    Chatgpt { token: String },
}

impl Credential {
    fn bearer(&self) -> &str {
        match self {
            Self::ApiKey { token } | Self::Chatgpt { token } => token,
        }
    }
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::ApiKey { .. } => "Credential::ApiKey(..)",
            Self::Chatgpt { .. } => "Credential::Chatgpt(..)",
        })
    }
}

pub struct Request<'a> {
    pub model: &'a str,
    /// `low`, `medium` or `high`.
    pub reasoning_effort: &'a str,
    pub instructions: &'a str,
    /// The whole conversation so far: Sign in with ChatGPT doesn't support
    /// `previous_response_id`, and `store: false` means nothing is kept
    /// server-side, so every turn resends it.
    pub input: &'a [Value],
    pub schema_name: &'a str,
    pub schema: Value,
    /// Function tool definitions; empty for none.
    pub tools: &'a [Value],
    /// Set to stop the model calling tools and make it answer.
    pub forbid_tools: bool,
}

/// A user message input item.
pub fn user_message(text: &str) -> Value {
    json!({ "role": "user", "content": text })
}

/// What the model produced in one turn.
#[derive(Debug, Default)]
pub struct Turn {
    /// Output items in order (reasoning, messages, function calls), ready to
    /// append to the next turn's input.
    pub items: Vec<Value>,
    /// The final answer text, when the model answered rather than calling tools.
    pub text: String,
}

pub struct FunctionCall<'a> {
    pub call_id: &'a str,
    pub name: &'a str,
    pub arguments: &'a str,
}

impl Turn {
    pub fn function_calls(&self) -> impl Iterator<Item = FunctionCall<'_>> {
        self.items
            .iter()
            .filter(|item| item["type"] == "function_call")
            .map(|item| FunctionCall {
                call_id: item["call_id"].as_str().unwrap_or_default(),
                name: item["name"].as_str().unwrap_or_default(),
                arguments: item["arguments"].as_str().unwrap_or_default(),
            })
    }
}

/// The input item answering a function call.
pub fn function_output(call_id: &str, output: String) -> Value {
    json!({ "type": "function_call_output", "call_id": call_id, "output": output })
}

/// Runs one turn with structured output. `on_progress` receives the number of
/// answer characters generated so far in this turn.
pub async fn respond(
    http: &reqwest::Client,
    base_url: &str,
    credential: &Credential,
    request: Request<'_>,
    mut on_progress: impl FnMut(usize),
) -> anyhow::Result<Turn> {
    let mut body = json!({
        "model": request.model,
        "instructions": request.instructions,
        "input": request.input,
        "reasoning": { "effort": request.reasoning_effort },
        "text": {
            "format": {
                "type": "json_schema",
                "name": request.schema_name,
                "schema": request.schema,
                "strict": true,
            }
        },
        // With `store: false`, reasoning only carries over between turns if
        // its encrypted form is sent back.
        "include": ["reasoning.encrypted_content"],
        "store": false,
        "stream": true,
    });
    if !request.tools.is_empty() {
        body["tools"] = Value::from(request.tools);
        body["tool_choice"] = Value::from(if request.forbid_tools { "none" } else { "auto" });
    }

    let response = http
        .post(format!("{base_url}/responses"))
        .bearer_auth(credential.bearer())
        .json(&body)
        .send()
        .await
        .context("couldn't reach OpenAI")?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }

    let mut parser = sse::Parser::default();
    let mut turn = Turn::default();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("stream from OpenAI was interrupted")?;
        for data in parser.push(&chunk) {
            let event: Value = serde_json::from_str(&data).context("malformed event from OpenAI")?;
            match event["type"].as_str() {
                Some("response.output_text.delta") => {
                    turn.text.push_str(event["delta"].as_str().unwrap_or_default());
                    on_progress(turn.text.len());
                }
                // Sent back unchanged (ids included) on the next turn, as
                // OpenAI's stateless reasoning examples do.
                Some("response.output_item.done") => turn.items.push(event["item"].clone()),
                Some("response.completed") => return Ok(turn),
                Some("response.incomplete") => {
                    let reason = event["response"]["incomplete_details"]["reason"]
                        .as_str()
                        .unwrap_or("unknown");
                    bail!("the model stopped early ({reason})");
                }
                Some("response.failed") => bail!("{}", error_message(&event["response"]["error"])),
                Some("error") => bail!("{}", error_message(&event)),
                _ => {}
            }
        }
    }
    bail!("OpenAI closed the stream before the response completed")
}

/// Model ids the credential can use.
pub async fn list_models(
    http: &reqwest::Client,
    base_url: &str,
    credential: &Credential,
) -> anyhow::Result<Vec<String>> {
    let response = http
        .get(format!("{base_url}/models"))
        .bearer_auth(credential.bearer())
        .send()
        .await
        .context("couldn't reach OpenAI")?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let body: Value = response.json().await?;
    let mut models: Vec<String> = body["data"]
        .as_array()
        .ok_or_else(|| anyhow!("unexpected models response"))?
        .iter()
        // Sign in with ChatGPT marks pickable models with visibility "list".
        .filter(|m| m["visibility"].as_str().is_none_or(|v| v == "list"))
        .filter_map(|m| m["id"].as_str().map(str::to_owned))
        .collect();
    models.sort();
    Ok(models)
}

fn error_message(error: &Value) -> String {
    error["message"]
        .as_str()
        .or(error["error"]["message"].as_str())
        .unwrap_or("the model request failed")
        .to_owned()
}

async fn api_error(response: reqwest::Response) -> anyhow::Error {
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let message = error_message(&body["error"]);
    match status.as_u16() {
        401 => anyhow!("OpenAI rejected the credential: {message}"),
        429 => anyhow!("OpenAI rate limit or quota reached: {message}"),
        _ => anyhow!("OpenAI returned {status}: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use axum::{Router, body::Body, http::StatusCode, response::Response, routing::post};
    use serde_json::json;

    use super::*;

    /// Serves `body` from `/responses` with `status`, in small chunks.
    async fn mock(status: StatusCode, body: &'static str) -> String {
        let app = Router::new().route(
            "/responses",
            post(move || async move {
                let chunks = body.as_bytes().chunks(7).map(|c| Ok::<_, std::io::Error>(c.to_vec()));
                Response::builder()
                    .status(status)
                    .header("content-type", "text/event-stream")
                    .body(Body::from_stream(futures_util::stream::iter(chunks)))
                    .unwrap()
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    fn request() -> Request<'static> {
        Request {
            model: "m",
            reasoning_effort: "medium",
            instructions: "i",
            input: &[],
            schema_name: "s",
            schema: json!({}),
            tools: &[],
            forbid_tools: false,
        }
    }

    fn credential() -> Credential {
        Credential::ApiKey {
            token: "sk-test".into(),
        }
    }

    #[tokio::test]
    async fn collects_streamed_output() {
        let base = mock(
            StatusCode::OK,
            "event: response.created\ndata: {\"type\":\"response.created\"}\n\n\
             data: {\"type\":\"response.output_text.delta\",\"delta\":\"{\\\"a\\\":\"}\n\n\
             data: {\"type\":\"response.output_text.delta\",\"delta\":\"1}\"}\n\n\
             data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
        )
        .await;
        let mut progress = Vec::new();
        let turn = respond(&reqwest::Client::new(), &base, &credential(), request(), |n| {
            progress.push(n)
        })
        .await
        .unwrap();
        assert_eq!(turn.text, r#"{"a":1}"#);
        assert_eq!(progress, vec![5, 7]);
    }

    #[tokio::test]
    async fn collects_function_calls() {
        let base = mock(
            StatusCode::OK,
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"encrypted_content\":\"e\"}}\n\n\
             data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"c1\",\"name\":\"read_file\",\"arguments\":\"{}\"}}\n\n\
             data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
        )
        .await;
        let turn = respond(&reqwest::Client::new(), &base, &credential(), request(), |_| {})
            .await
            .unwrap();
        assert_eq!(turn.items.len(), 2);
        assert_eq!(turn.items[0]["encrypted_content"], "e");
        let calls: Vec<_> = turn.function_calls().map(|c| (c.call_id, c.name)).collect();
        assert_eq!(calls, vec![("c1", "read_file")]);
    }

    #[tokio::test]
    async fn reports_failures() {
        let base = mock(
            StatusCode::OK,
            "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"usage limit\"}}}\n\n",
        )
        .await;
        let err = respond(&reqwest::Client::new(), &base, &credential(), request(), |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "usage limit");
    }

    #[tokio::test]
    async fn reports_rejected_credentials() {
        let base = mock(StatusCode::UNAUTHORIZED, r#"{"error":{"message":"Incorrect API key"}}"#).await;
        let err = respond(&reqwest::Client::new(), &base, &credential(), request(), |_| {})
            .await
            .unwrap_err();
        assert!(err.to_string().contains("rejected the credential"));
    }

    #[tokio::test]
    async fn errors_if_stream_ends_early() {
        let base = mock(
            StatusCode::OK,
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n",
        )
        .await;
        let err = respond(&reqwest::Client::new(), &base, &credential(), request(), |_| {})
            .await
            .unwrap_err();
        assert!(err.to_string().contains("before the response completed"));
    }
}

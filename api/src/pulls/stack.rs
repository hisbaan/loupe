//! Stacked pull requests: each layer targets the branch of the layer below, so
//! its diff is just that layer.
//!
//! GitHub's own stacks come from `GET /repos/{owner}/{repo}/stacks`, which
//! `gh stack` uses but GitHub's REST reference doesn't document. When it's
//! missing (stacks not enabled, a 404) or fails, the stack is worked out by
//! following branches between open pull requests in the same repository, which
//! also finds stacks made with other tools.

use std::collections::{BTreeMap, HashSet};

use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{GitRef, is_github_name};
use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    github::{self, get_json},
    state::AppState,
};

const MAX_LAYERS: usize = 20;

#[derive(Debug, Clone, Serialize)]
pub struct Stack {
    /// GitHub's stack number; `None` when worked out from branches.
    pub number: Option<u64>,
    /// The branch the bottom layer targets.
    pub base: String,
    /// Bottom first.
    pub layers: Vec<Layer>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Layer {
    pub number: u64,
    pub title: String,
    /// `open`, `closed` or `merged`.
    pub state: String,
    pub draft: bool,
}

#[derive(Serialize)]
pub struct StackResponse {
    stack: Option<Stack>,
}

pub async fn get_stack(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
) -> AppResult<Json<StackResponse>> {
    let token = github::user_token(&state, user.id).await?;
    let stack = fetch_stack(&state, &token, &owner, &repo, number).await?;
    Ok(Json(StackResponse { stack }))
}

/// The stack `number` belongs to, if any, read with the user's `token`.
pub async fn fetch_stack(
    state: &AppState,
    token: &str,
    owner: &str,
    repo: &str,
    number: u64,
) -> AppResult<Option<Stack>> {
    if !is_github_name(owner) || !is_github_name(repo) {
        return Err(AppError::BadRequest("invalid owner or repo".into()));
    }
    match github_stack(state, token, owner, repo, number).await {
        Ok(Some(stack)) => return Ok(Some(stack)),
        Ok(None) => {}
        Err(err) => tracing::warn!("reading GitHub's stack, following branches instead: {err}"),
    }
    branch_stack(state, token, owner, repo, number).await
}

#[derive(Deserialize)]
struct RemoteStack {
    number: u64,
    base: RemoteBase,
    /// Bottom first.
    pull_requests: Vec<RemotePull>,
}

#[derive(Deserialize)]
struct RemoteBase {
    #[serde(rename = "ref")]
    name: String,
}

#[derive(Deserialize)]
struct RemotePull {
    number: u64,
    state: String,
    #[serde(default)]
    draft: bool,
    merged_at: Option<String>,
}

async fn github_stack(state: &AppState, token: &str, owner: &str, repo: &str, number: u64) -> AppResult<Option<Stack>> {
    let path = format!("/repos/{owner}/{repo}/stacks?pull_request={number}");
    let Some(stacks) = github::get_json_if_found::<Vec<RemoteStack>>(state, token, &path).await? else {
        return Ok(None);
    };
    let Some(stack) = stacks.into_iter().next() else {
        return Ok(None);
    };
    let pulls: Vec<_> = stack.pull_requests.into_iter().take(MAX_LAYERS).collect();
    let numbers: Vec<u64> = pulls.iter().map(|p| p.number).collect();
    let mut titles = titles(state, token, owner, repo, &numbers).await?;
    let layers = pulls
        .into_iter()
        .map(|p| Layer {
            number: p.number,
            title: titles.remove(&p.number).unwrap_or_default(),
            state: layer_state(&p.state, p.merged_at.as_deref()),
            draft: p.draft,
        })
        .collect();
    Ok(Some(Stack {
        number: Some(stack.number),
        base: stack.base.name,
        layers,
    }))
}

#[derive(Deserialize)]
struct TitleNode {
    number: u64,
    title: String,
}

#[derive(Deserialize)]
struct TitleData {
    repository: Option<BTreeMap<String, Option<TitleNode>>>,
}

/// Titles of pull requests in one repository, in one GraphQL query.
async fn titles(
    state: &AppState,
    token: &str,
    owner: &str,
    repo: &str,
    numbers: &[u64],
) -> AppResult<BTreeMap<u64, String>> {
    if numbers.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut params = String::from("$owner: String!, $name: String!");
    let mut fields = String::new();
    let mut variables = json!({ "owner": owner, "name": repo });
    for (i, number) in numbers.iter().enumerate() {
        params.push_str(&format!(", $p{i}: Int!"));
        fields.push_str(&format!("p{i}: pullRequest(number: $p{i}) {{ number title }} "));
        variables[format!("p{i}")] = json!(number);
    }
    let query = format!("query({params}) {{ repository(owner: $owner, name: $name) {{ {fields}}} }}");
    let response = github::graphql::<TitleData>(state, token, &query, variables).await?;
    Ok(response
        .data
        .and_then(|d| d.repository)
        .into_iter()
        .flatten()
        .filter_map(|(_, node)| node.map(|n| (n.number, n.title)))
        .collect())
}

#[derive(Deserialize)]
struct ListedPull {
    number: u64,
    title: String,
    state: String,
    draft: Option<bool>,
    merged_at: Option<String>,
    base: GitRef,
    head: GitRef,
}

impl ListedPull {
    /// Stacks only exist within one repository.
    fn same_repo(&self) -> bool {
        matches!((&self.base.repo, &self.head.repo), (Some(base), Some(head)) if base.id == head.id)
    }

    fn layer(&self) -> Layer {
        Layer {
            number: self.number,
            title: self.title.clone(),
            state: layer_state(&self.state, self.merged_at.as_deref()),
            draft: self.draft.unwrap_or(false),
        }
    }
}

/// Follows open pull requests down (whose head is this one's base) and up
/// (whose base is this one's head). A branch with more than one pull request on
/// top of it isn't a stack, so the walk stops there.
async fn branch_stack(state: &AppState, token: &str, owner: &str, repo: &str, number: u64) -> AppResult<Option<Stack>> {
    let pull: ListedPull = get_json(state, token, &format!("/repos/{owner}/{repo}/pulls/{number}")).await?;
    if !pull.same_repo() {
        return Ok(None);
    }
    let mut seen = HashSet::from([pull.number]);

    let mut below = Vec::new();
    let mut base = pull.base.name.clone();
    while seen.len() < MAX_LAYERS {
        let head = format!("{owner}:{base}");
        let path = format!(
            "/repos/{owner}/{repo}/pulls?state=open&per_page=2&head={}",
            encode(&head)
        );
        let Some(next) = only(get_json(state, token, &path).await?) else {
            break;
        };
        if !next.same_repo() || !seen.insert(next.number) {
            break;
        }
        base = next.base.name.clone();
        below.push(next);
    }

    let mut above = Vec::new();
    let mut head = pull.head.name.clone();
    while seen.len() < MAX_LAYERS {
        let path = format!(
            "/repos/{owner}/{repo}/pulls?state=open&per_page=2&base={}",
            encode(&head)
        );
        let Some(next) = only(get_json(state, token, &path).await?) else {
            break;
        };
        if !next.same_repo() || !seen.insert(next.number) {
            break;
        }
        head = next.head.name.clone();
        above.push(next);
    }

    if below.is_empty() && above.is_empty() {
        return Ok(None);
    }
    let layers: Vec<Layer> = below
        .iter()
        .rev()
        .chain([&pull])
        .chain(above.iter())
        .map(ListedPull::layer)
        .collect();
    Ok(Some(Stack {
        number: None,
        base,
        layers,
    }))
}

fn only(mut pulls: Vec<ListedPull>) -> Option<ListedPull> {
    if pulls.len() == 1 { pulls.pop() } else { None }
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn layer_state(state: &str, merged_at: Option<&str>) -> String {
    if merged_at.is_some_and(|m| !m.is_empty()) {
        "merged".to_owned()
    } else {
        state.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_stacks() {
        let stacks: Vec<RemoteStack> = serde_json::from_value(json!([{
            "id": 1, "number": 7, "node_id": "S_1", "url": "https://github.com/o/r/stack/7",
            "base": { "ref": "main", "sha": "abc" }, "open": true, "created_at": "2026-01-01T00:00:00Z",
            "pull_requests": [
                { "number": 10, "state": "closed", "draft": false, "merged_at": "2026-01-02T00:00:00Z", "head": { "ref": "a", "sha": "1" } },
                { "number": 11, "state": "open", "draft": true, "merged_at": null, "head": { "ref": "b", "sha": "2" } }
            ]
        }]))
        .unwrap();
        let stack = &stacks[0];
        assert_eq!(stack.number, 7);
        assert_eq!(stack.base.name, "main");
        let states: Vec<_> = stack
            .pull_requests
            .iter()
            .map(|p| layer_state(&p.state, p.merged_at.as_deref()))
            .collect();
        assert_eq!(states, ["merged", "open"]);
    }

    #[test]
    fn encodes_branch_names() {
        assert_eq!(encode("o:feat/a&b=c"), "o%3Afeat%2Fa%26b%3Dc");
    }
}

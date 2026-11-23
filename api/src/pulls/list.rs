//! The home page's pull request list: open pull requests the user wrote, was
//! asked to review, or can merge. Everything is fetched with the user's own
//! token, and a GitHub App user token only reaches repositories the app is
//! installed on, so every listed pull request is one Loupe can open.
//!
//! The REST API only finds the repositories; one GraphQL query then runs both
//! searches and lists every repository's open pull requests, instead of a
//! REST call per repository. Results are cached per user for a minute.

use std::{
    collections::{BTreeMap, HashMap},
    fmt::Write as _,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{Query, State},
};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Author, is_github_name};
use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    github::{self, get_json},
    state::AppState,
};

/// Repositories with write access whose open pull requests are listed, most
/// recently pushed first; keeps large organizations from fanning out.
const MAX_REPOS: usize = 30;
const MAX_INSTALLATIONS: usize = 10;
const PULLS_PER_REPO: u32 = 30;
const SEARCH_RESULTS: u32 = 50;
const CONCURRENCY: usize = 6;
const CACHE_TTL: Duration = Duration::from_secs(60);

/// Why a pull request is listed, most relevant first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    ReviewRequested,
    Authored,
    Maintainer,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullSummary {
    /// `owner/name`.
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub author: Author,
    pub draft: bool,
    pub updated_at: String,
    pub html_url: String,
    pub reasons: Vec<Reason>,
    /// Branches, to group stacked pull requests (each targets the branch of
    /// the one below it).
    pub base_ref: String,
    pub head_ref: String,
    /// The head branch is in a fork, so it can't be part of a stack.
    pub cross_repository: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullListResponse {
    pub pulls: Vec<PullSummary>,
    /// Some lookups failed, so pull requests may be missing.
    pub partial: bool,
}

/// Each user's last list, served only back to that user.
#[derive(Default)]
pub struct PullListCache(Mutex<HashMap<i64, (Instant, PullListResponse)>>);

impl PullListCache {
    fn get(&self, user_id: i64) -> Option<PullListResponse> {
        let cache = self.0.lock().unwrap();
        let (at, response) = cache.get(&user_id)?;
        (at.elapsed() < CACHE_TTL).then(|| response.clone())
    }

    fn put(&self, user_id: i64, response: PullListResponse) {
        let mut cache = self.0.lock().unwrap();
        cache.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
        cache.insert(user_id, (Instant::now(), response));
    }
}

#[derive(Deserialize)]
pub struct ListParams {
    /// Skip the cache, e.g. for an explicit refresh.
    #[serde(default)]
    refresh: bool,
}

#[derive(Deserialize)]
struct Installations {
    installations: Vec<Installation>,
}

#[derive(Deserialize)]
struct Installation {
    id: i64,
}

#[derive(Deserialize)]
struct InstallationRepos {
    repositories: Vec<InstallationRepo>,
}

#[derive(Deserialize)]
struct InstallationRepo {
    full_name: String,
    #[serde(default)]
    archived: bool,
    pushed_at: Option<String>,
    permissions: Option<Permissions>,
}

#[derive(Deserialize, Default)]
struct Permissions {
    #[serde(default)]
    admin: bool,
    #[serde(default)]
    maintain: bool,
    #[serde(default)]
    push: bool,
}

/// A top-level field of the GraphQL response: a search (`nodes`) or a
/// repository (`pullRequests.nodes`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Field {
    nodes: Option<Vec<Value>>,
    pull_requests: Option<Nodes>,
}

#[derive(Deserialize)]
struct Nodes {
    nodes: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullNode {
    number: u64,
    title: String,
    is_draft: bool,
    updated_at: String,
    url: String,
    /// `None` for deleted accounts.
    author: Option<NodeAuthor>,
    repository: NodeRepo,
    base_ref_name: String,
    head_ref_name: String,
    is_cross_repository: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeAuthor {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeRepo {
    name_with_owner: String,
}

pub async fn list(
    user: CurrentUser,
    State(state): State<AppState>,
    Query(params): Query<ListParams>,
) -> AppResult<Json<PullListResponse>> {
    if !params.refresh
        && let Some(cached) = state.pull_lists.get(user.id)
    {
        return Ok(Json(cached));
    }

    let token = github::user_token(&state, user.id).await?;
    let (repos, mut partial) = match writable_repos(&state, &token).await {
        Ok(found) => found,
        Err(err) => {
            tracing::warn!("listing installed repositories: {err}");
            (Vec::new(), true)
        }
    };

    let (query, variables) = build_query(&repos);
    let response = github::graphql::<BTreeMap<String, Option<Field>>>(&state, &token, &query, variables).await?;
    for error in &response.errors {
        tracing::warn!("listing pull requests: {}", error.message);
        partial = true;
    }
    let data = response.data.ok_or(AppError::GitHub {
        status: axum::http::StatusCode::BAD_GATEWAY,
    })?;

    let mut merged: BTreeMap<(String, u64), PullSummary> = BTreeMap::new();
    for (alias, field) in data {
        let Some(field) = field else { continue };
        let reason = match alias.as_str() {
            "requested" => Reason::ReviewRequested,
            "authored" => Reason::Authored,
            _ => Reason::Maintainer,
        };
        let nodes = field.nodes.or(field.pull_requests.map(|p| p.nodes)).unwrap_or_default();
        // Search results that aren't pull requests come back as `{}`.
        for node in nodes
            .into_iter()
            .filter_map(|node| serde_json::from_value::<PullNode>(node).ok())
        {
            let key = (node.repository.name_with_owner.clone(), node.number);
            merged.entry(key).or_insert_with(|| summary(node)).reasons.push(reason);
        }
    }

    let mut pulls: Vec<_> = merged.into_values().collect();
    for pull in &mut pulls {
        pull.reasons.sort();
        pull.reasons.dedup();
    }
    // ISO 8601 timestamps in UTC sort lexically.
    pulls.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let response = PullListResponse { pulls, partial };
    // A partial list would otherwise hide the missing pull requests for a minute.
    if !partial {
        state.pull_lists.put(user.id, response.clone());
    }
    Ok(Json(response))
}

fn summary(node: PullNode) -> PullSummary {
    let author = node.author.map_or_else(
        || Author {
            login: "ghost".to_owned(),
            avatar_url: None,
        },
        |a| Author {
            login: a.login,
            avatar_url: a.avatar_url,
        },
    );
    PullSummary {
        repo: node.repository.name_with_owner,
        number: node.number,
        title: node.title,
        author,
        draft: node.is_draft,
        updated_at: node.updated_at,
        html_url: node.url,
        reasons: Vec::new(),
        base_ref: node.base_ref_name,
        head_ref: node.head_ref_name,
        cross_repository: node.is_cross_repository,
    }
}

/// Both searches, plus one aliased `repository` field per repository; names
/// go in as variables.
fn build_query(repos: &[(String, String)]) -> (String, Value) {
    let mut params = String::from("$requested: String!, $authored: String!");
    let mut fields = format!(
        "requested: search(query: $requested, type: ISSUE, first: {SEARCH_RESULTS}) {{ nodes {{ ...pull }} }}\n\
         authored: search(query: $authored, type: ISSUE, first: {SEARCH_RESULTS}) {{ nodes {{ ...pull }} }}\n"
    );
    let mut variables = json!({
        "requested": "is:pr is:open archived:false review-requested:@me",
        "authored": "is:pr is:open archived:false author:@me",
    });
    for (i, (owner, name)) in repos.iter().enumerate() {
        let _ = write!(params, ", $o{i}: String!, $n{i}: String!");
        let _ = writeln!(
            fields,
            "r{i}: repository(owner: $o{i}, name: $n{i}) {{ pullRequests(states: OPEN, first: {PULLS_PER_REPO}, \
             orderBy: {{field: UPDATED_AT, direction: DESC}}) {{ nodes {{ ...pull }} }} }}"
        );
        variables[format!("o{i}")] = json!(owner);
        variables[format!("n{i}")] = json!(name);
    }
    let query = format!(
        "query({params}) {{\n{fields}}}\n\
         fragment pull on PullRequest {{ number title isDraft updatedAt url \
         author {{ login avatarUrl }} repository {{ nameWithOwner }} baseRefName headRefName isCrossRepository }}"
    );
    (query, variables)
}

/// `(owner, name)` of installed, unarchived repositories the user can push
/// to, most recently pushed first, and whether every installation was read.
async fn writable_repos(state: &AppState, token: &str) -> AppResult<(Vec<(String, String)>, bool)> {
    let installations: Installations = get_json(state, token, "/user/installations?per_page=100").await?;

    let pages: Vec<AppResult<InstallationRepos>> =
        stream::iter(installations.installations.into_iter().take(MAX_INSTALLATIONS))
            .map(|installation| async move {
                get_json(
                    state,
                    token,
                    &format!("/user/installations/{}/repositories?per_page=100", installation.id),
                )
                .await
            })
            .buffer_unordered(CONCURRENCY)
            .collect()
            .await;

    let mut complete = true;
    let mut repos = Vec::new();
    for page in pages {
        match page {
            Ok(page) => repos.extend(page.repositories.into_iter().filter(|repo| {
                let p = repo.permissions.as_ref();
                p.is_some_and(|p| p.admin || p.maintain || p.push) && !repo.archived
            })),
            Err(err) => {
                tracing::warn!("listing installation repositories: {err}");
                complete = false;
            }
        }
    }
    repos.sort_by(|a, b| b.pushed_at.cmp(&a.pushed_at));
    let repos = repos
        .into_iter()
        .filter_map(|repo| {
            let (owner, name) = repo.full_name.split_once('/')?;
            (is_github_name(owner) && is_github_name(name)).then(|| (owner.to_owned(), name.to_owned()))
        })
        .take(MAX_REPOS)
        .collect();
    Ok((repos, complete))
}

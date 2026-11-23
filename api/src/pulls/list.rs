//! The home page's pull request list: open pull requests the user wrote, was
//! asked to review, or can merge. Everything is fetched with the user's own
//! token, and a GitHub App user token only reaches repositories the app is
//! installed on, so every listed pull request is one Loupe can open.

use std::collections::BTreeMap;

use axum::{Json, extract::State};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};

use super::{Author, is_github_name};
use crate::{
    auth::CurrentUser,
    error::AppResult,
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

/// Why a pull request is listed, most relevant first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    ReviewRequested,
    Authored,
    Maintainer,
}

#[derive(Debug, Serialize)]
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
}

#[derive(Debug, Serialize)]
pub struct PullListResponse {
    pub pulls: Vec<PullSummary>,
}

#[derive(Deserialize)]
struct SearchResults {
    items: Vec<SearchItem>,
}

#[derive(Deserialize)]
struct SearchItem {
    number: u64,
    title: String,
    user: Author,
    draft: Option<bool>,
    updated_at: String,
    html_url: String,
    /// `https://api.github.com/repos/{owner}/{name}`.
    repository_url: String,
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

#[derive(Deserialize)]
struct ListedPull {
    number: u64,
    title: String,
    user: Author,
    draft: Option<bool>,
    updated_at: String,
    html_url: String,
}

pub async fn list(user: CurrentUser, State(state): State<AppState>) -> AppResult<Json<PullListResponse>> {
    let token = github::user_token(&state, user.id).await?;
    let (requested, authored, maintained) = tokio::join!(
        search(&state, &token, "review-requested:@me", Reason::ReviewRequested),
        search(&state, &token, "author:@me", Reason::Authored),
        maintained(&state, &token),
    );

    let mut first_error = None;
    let mut found = Vec::new();
    for result in [requested, authored, maintained] {
        match result {
            Ok(pulls) => found.extend(pulls),
            Err(err) => {
                tracing::warn!("listing pull requests: {err}");
                first_error.get_or_insert(err);
            }
        }
    }
    if found.is_empty()
        && let Some(err) = first_error
    {
        return Err(err);
    }

    let mut merged: BTreeMap<(String, u64), PullSummary> = BTreeMap::new();
    for pull in found {
        match merged.get_mut(&(pull.repo.clone(), pull.number)) {
            Some(existing) => existing.reasons.extend(pull.reasons),
            None => {
                merged.insert((pull.repo.clone(), pull.number), pull);
            }
        }
    }
    let mut pulls: Vec<_> = merged.into_values().collect();
    for pull in &mut pulls {
        pull.reasons.sort();
        pull.reasons.dedup();
    }
    // ISO 8601 timestamps in UTC sort lexically.
    pulls.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(Json(PullListResponse { pulls }))
}

async fn search(state: &AppState, token: &str, qualifier: &str, reason: Reason) -> AppResult<Vec<PullSummary>> {
    let query = format!("is:pr is:open archived:false {qualifier}");
    let query: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
    let results: SearchResults = get_json(
        state,
        token,
        &format!("/search/issues?q={query}&sort=updated&order=desc&per_page={SEARCH_RESULTS}"),
    )
    .await?;
    Ok(results
        .items
        .into_iter()
        .filter_map(|item| {
            let repo = item.repository_url.strip_prefix("https://api.github.com/repos/")?;
            let repo = is_full_name(repo).then(|| repo.to_owned())?;
            Some(PullSummary {
                repo,
                number: item.number,
                title: item.title,
                author: item.user,
                draft: item.draft.unwrap_or(false),
                updated_at: item.updated_at,
                html_url: item.html_url,
                reasons: vec![reason],
            })
        })
        .collect())
}

/// Open pull requests in repositories the user can push to.
async fn maintained(state: &AppState, token: &str) -> AppResult<Vec<PullSummary>> {
    let installations: Installations = get_json(state, token, "/user/installations?per_page=100").await?;

    let mut repos: Vec<InstallationRepo> =
        stream::iter(installations.installations.into_iter().take(MAX_INSTALLATIONS))
            .map(|installation| async move {
                get_json::<InstallationRepos>(
                    state,
                    token,
                    &format!("/user/installations/{}/repositories?per_page=100", installation.id),
                )
                .await
            })
            .buffer_unordered(CONCURRENCY)
            .filter_map(|result| async move {
                result
                    .inspect_err(|err| tracing::warn!("listing installation repositories: {err}"))
                    .ok()
            })
            .flat_map(|page| stream::iter(page.repositories))
            .filter(|repo| {
                let p = repo.permissions.as_ref();
                let writable = p.is_some_and(|p| p.admin || p.maintain || p.push);
                std::future::ready(writable && !repo.archived && is_full_name(&repo.full_name))
            })
            .collect()
            .await;
    repos.sort_by(|a, b| b.pushed_at.cmp(&a.pushed_at));
    repos.truncate(MAX_REPOS);

    let pages: Vec<Vec<PullSummary>> = stream::iter(repos)
        .map(|repo| async move {
            let path = format!(
                "/repos/{}/pulls?state=open&sort=updated&direction=desc&per_page={PULLS_PER_REPO}",
                repo.full_name
            );
            match get_json::<Vec<ListedPull>>(state, token, &path).await {
                Ok(pulls) => pulls
                    .into_iter()
                    .map(|pull| PullSummary {
                        repo: repo.full_name.clone(),
                        number: pull.number,
                        title: pull.title,
                        author: pull.user,
                        draft: pull.draft.unwrap_or(false),
                        updated_at: pull.updated_at,
                        html_url: pull.html_url,
                        reasons: vec![Reason::Maintainer],
                    })
                    .collect(),
                Err(err) => {
                    tracing::warn!(repo = repo.full_name, "listing pull requests: {err}");
                    Vec::new()
                }
            }
        })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;
    Ok(pages.into_iter().flatten().collect())
}

/// `owner/name`, both valid GitHub names, so it's safe to put in an API path.
fn is_full_name(s: &str) -> bool {
    s.split_once('/')
        .is_some_and(|(owner, name)| is_github_name(owner) && is_github_name(name))
}

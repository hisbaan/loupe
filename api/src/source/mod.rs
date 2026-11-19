//! Read-only access to a pull request's repository at its base and head
//! commits, for the review tools. Everything goes through the GitHub API with
//! the job user's token; nothing is cloned. Trees and blobs are addressed by
//! SHA, so they're cached in SQLite indefinitely (pruned only for space).
//!
//! The repository and commits are fixed when a [`Source`] is created from an
//! access-checked pull request. Callers (and the model) only choose paths
//! within those commits, so a prompt injection can't read anything else.

use std::{future::Future, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::{
    error::{AppError, AppResult},
    github,
    pulls::PullResponse,
    state::AppState,
};

/// Larger files aren't fetched at all.
pub const MAX_BLOB_BYTES: u64 = 1_000_000;
const RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Base,
    Head,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Head => "head",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub path: String,
    pub sha: String,
    pub size: u64,
}

/// The files (blobs) of one commit, sorted by path.
#[derive(Debug, Default)]
pub struct Tree {
    pub entries: Vec<Entry>,
    /// GitHub truncates very large trees (over 100,000 entries or 7 MB).
    pub truncated: bool,
}

impl Tree {
    pub fn new(mut entries: Vec<Entry>, truncated: bool) -> Self {
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Self { entries, truncated }
    }

    pub fn get(&self, path: &str) -> Option<&Entry> {
        let path = normalize(path);
        self.entries
            .binary_search_by(|e| e.path.as_str().cmp(path))
            .ok()
            .map(|i| &self.entries[i])
    }

    /// Files inside directory `prefix` (or everything for an empty prefix).
    pub fn under<'a>(&'a self, prefix: &'a str) -> impl Iterator<Item = &'a Entry> {
        let prefix = normalize(prefix);
        self.entries.iter().filter(move |e| {
            prefix.is_empty()
                || e.path
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        })
    }
}

/// Paths as the model might write them: `./src/`, `/src`, `src/`.
pub fn normalize(path: &str) -> &str {
    let path = path.trim();
    let path = path.strip_prefix("./").unwrap_or(path);
    path.trim_matches('/')
}

/// Repository reads available to the review tools.
pub trait Reader: Sync {
    fn tree(&self, side: Side) -> impl Future<Output = AppResult<Arc<Tree>>> + Send;
    fn blob(&self, entry: &Entry) -> impl Future<Output = AppResult<Arc<Vec<u8>>>> + Send;
}

pub struct Source {
    state: AppState,
    token: String,
    full_name: String,
    repo_id: i64,
    base_sha: String,
    head_sha: String,
    trees: Mutex<[Option<Arc<Tree>>; 2]>,
}

impl Source {
    /// `pr` must have been fetched with `token`. That fetch is the access check
    /// that makes the shared cache safe to read for this user.
    pub fn new(state: AppState, token: String, pr: &PullResponse) -> AppResult<Self> {
        let repo = pr
            .pull
            .base
            .repo
            .as_ref()
            .ok_or_else(|| AppError::Internal(anyhow::anyhow!("pull request has no base repository")))?;
        Ok(Self {
            state,
            token,
            // The base repository also holds the head commit, even for forks.
            full_name: repo.full_name.clone(),
            repo_id: repo.id,
            base_sha: pr.pull.base.sha.clone(),
            head_sha: pr.pull.head.sha.clone(),
            trees: Mutex::new([None, None]),
        })
    }

    async fn load_tree(&self, commit_sha: &str) -> AppResult<Tree> {
        let cached: Option<(String, bool)> =
            sqlx::query_as("SELECT entries, truncated FROM source_trees WHERE repo_id = ? AND commit_sha = ?")
                .bind(self.repo_id)
                .bind(commit_sha)
                .fetch_optional(&self.state.db)
                .await?;
        if let Some((entries, truncated)) = cached {
            let entries = serde_json::from_str(&entries).map_err(anyhow::Error::from)?;
            return Ok(Tree::new(entries, truncated));
        }

        #[derive(Deserialize)]
        struct GitTree {
            tree: Vec<GitEntry>,
            truncated: bool,
        }
        #[derive(Deserialize)]
        struct GitEntry {
            path: String,
            #[serde(rename = "type")]
            kind: String,
            sha: String,
            size: Option<u64>,
        }

        let path = format!("/repos/{}/git/trees/{commit_sha}?recursive=1", self.full_name);
        let git: GitTree = github::get_json(&self.state, &self.token, &path).await?;
        let entries: Vec<Entry> = git
            .tree
            .into_iter()
            .filter(|e| e.kind == "blob")
            .map(|e| Entry {
                path: e.path,
                sha: e.sha,
                size: e.size.unwrap_or(0),
            })
            .collect();
        sqlx::query(
            "INSERT INTO source_trees (repo_id, commit_sha, entries, truncated) VALUES (?, ?, ?, ?)
             ON CONFLICT DO NOTHING",
        )
        .bind(self.repo_id)
        .bind(commit_sha)
        .bind(serde_json::to_string(&entries).map_err(anyhow::Error::from)?)
        .bind(git.truncated)
        .execute(&self.state.db)
        .await?;
        Ok(Tree::new(entries, git.truncated))
    }
}

impl Reader for Source {
    async fn tree(&self, side: Side) -> AppResult<Arc<Tree>> {
        let mut trees = self.trees.lock().await;
        let slot = &mut trees[side as usize];
        if let Some(tree) = slot {
            return Ok(tree.clone());
        }
        let sha = match side {
            Side::Base => &self.base_sha,
            Side::Head => &self.head_sha,
        };
        let tree = Arc::new(self.load_tree(sha).await?);
        *slot = Some(tree.clone());
        Ok(tree)
    }

    async fn blob(&self, entry: &Entry) -> AppResult<Arc<Vec<u8>>> {
        if entry.size > MAX_BLOB_BYTES {
            return Err(AppError::BadRequest(format!("{} is too large to read", entry.path)));
        }
        let cached: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT content FROM source_blobs WHERE repo_id = ? AND blob_sha = ?")
                .bind(self.repo_id)
                .bind(&entry.sha)
                .fetch_optional(&self.state.db)
                .await?;
        if let Some(content) = cached {
            return Ok(Arc::new(content));
        }
        let path = format!("/repos/{}/git/blobs/{}", self.full_name, entry.sha);
        let content = github::get_raw(&self.state, &self.token, &path).await?;
        sqlx::query("INSERT INTO source_blobs (repo_id, blob_sha, content) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
            .bind(self.repo_id)
            .bind(&entry.sha)
            .bind(&content)
            .execute(&self.state.db)
            .await?;
        Ok(Arc::new(content))
    }
}

/// Deletes cached trees and blobs older than the retention period, daily.
pub fn spawn_pruning(db: sqlx::SqlitePool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(24 * 60 * 60));
        loop {
            interval.tick().await;
            for sql in [
                "DELETE FROM source_trees WHERE created_at < unixepoch() - ?",
                "DELETE FROM source_blobs WHERE created_at < unixepoch() - ?",
            ] {
                if let Err(err) = sqlx::query(sql).bind(RETENTION.as_secs() as i64).execute(&db).await {
                    tracing::warn!("pruning the source cache failed: {err}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> Tree {
        let entry = |path: &str| Entry {
            path: path.into(),
            sha: "s".into(),
            size: 1,
        };
        Tree::new(
            vec![
                entry("src/main.rs"),
                entry("README.md"),
                entry("src2/x.rs"),
                entry("src/a/b.rs"),
            ],
            false,
        )
    }

    #[test]
    fn looks_up_normalized_paths() {
        let tree = tree();
        assert!(tree.get("./src/main.rs").is_some());
        assert!(tree.get("/README.md").is_some());
        assert!(tree.get("src").is_none());
        assert!(tree.get("../etc/passwd").is_none());
    }

    #[test]
    fn lists_directories_not_string_prefixes() {
        let tree = tree();
        let paths: Vec<_> = tree.under("src/").map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["src/a/b.rs", "src/main.rs"]);
        assert_eq!(tree.under("").count(), 4);
    }
}

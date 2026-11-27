//! The review schema produced by the model and stored in the cache. Bump
//! [`SCHEMA_VERSION`] on any breaking change; cache keys include it.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 2;

/// Deterministic, verifiable classification from the pre-pass. The client can
/// re-check these, so they may collapse a hunk even when the review comes from
/// someone you don't trust.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HunkKind {
    Code,
    ImportOnly,
    Lockfile,
    Generated,
    Vendored,
    Rename,
    WhitespaceOnly,
    Docs,
    Test,
    Config,
}

impl HunkKind {
    /// Kinds that may be collapsed without the model's input. Whether a given
    /// hunk actually is collapsed also depends on the pre-pass's safety checks.
    pub fn collapsible(self) -> bool {
        matches!(
            self,
            Self::ImportOnly | Self::Lockfile | Self::Generated | Self::Vendored | Self::Rename | Self::WhitespaceOnly
        )
    }
}

/// How carefully a section deserves reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Attention {
    ReviewClosely,
    Read,
    Skim,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagram {
    /// Always `"mermaid"`.
    pub kind: String,
    pub source: String,
    pub caption: Option<String>,
}

/// Hunks that belong together by what they do, not by file, with prose that
/// is shown above their code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Section {
    pub title: String,
    pub attention: Attention,
    /// Markdown.
    pub overview: String,
    /// In reading order. Every reviewable hunk is in exactly one section.
    pub hunk_ids: Vec<String>,
    pub diagram: Option<Diagram>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Must be fixed before merging: a bug, data loss, a security hole.
    Blocker,
    Major,
    Minor,
    Nit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Bug,
    Security,
    Performance,
    Design,
    /// Doesn't follow the patterns the surrounding code uses.
    Convention,
    Test,
    Question,
    /// The pull request's content seems to be trying to steer the review.
    Suspicious,
}

/// Which version of the file a line number refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineSide {
    /// The pull request's head commit (added and context lines).
    New,
    /// The base commit (removed lines).
    Old,
}

/// A specific problem or question, pinned to lines inside one hunk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    /// Stable within one review, e.g. `f3`.
    pub id: String,
    pub hunk_id: String,
    pub path: String,
    pub side: LineSide,
    /// Inclusive, 1-based, within the hunk.
    pub start_line: u32,
    pub end_line: u32,
    pub severity: Severity,
    pub category: Category,
    pub title: String,
    /// Markdown.
    pub body: String,
    pub suggestion: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Review {
    pub schema_version: u32,
    /// Markdown overview of the whole pull request.
    pub summary: String,
    /// Most important first.
    pub sections: Vec<Section>,
    pub findings: Vec<Finding>,
    /// Short notes on particular hunks, only where they add something.
    pub hunk_notes: BTreeMap<String, String>,
    pub questions: Vec<String>,
}

impl Review {
    /// Hunk ids from the diff that no section places. A review with missing
    /// hunks must be rejected rather than silently rendered.
    pub fn missing_hunks<'a>(&self, diff_hunk_ids: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
        let placed: HashSet<&str> = self
            .sections
            .iter()
            .flat_map(|s| s.hunk_ids.iter().map(String::as_str))
            .collect();
        diff_hunk_ids.into_iter().filter(|id| !placed.contains(id)).collect()
    }
}

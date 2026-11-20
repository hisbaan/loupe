//! Self-review: problems found in your own pull request, pinned to file lines,
//! to hand to a coding agent. Cache and storage keys include
//! [`SELF_REVIEW_SCHEMA_VERSION`].

use serde::{Deserialize, Serialize};

pub const SELF_REVIEW_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Must be fixed before merging: a bug, data loss, a security hole.
    Blocker,
    Major,
    Minor,
    Nit,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    /// Stable within one self-review, e.g. `f3`.
    pub id: String,
    pub path: String,
    pub side: LineSide,
    /// Inclusive, 1-based, within one hunk.
    pub start_line: u32,
    pub end_line: u32,
    pub severity: Severity,
    pub title: String,
    pub body: String,
    pub suggestion: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelfReview {
    pub schema_version: u32,
    pub summary: String,
    pub findings: Vec<Finding>,
}

//! The guided review schema produced by the model and stored in the cache.
//! Bump [`SCHEMA_VERSION`] on any breaking change; cache keys include it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Importance {
    Critical,
    Normal,
    Low,
}

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
    Rename,
    WhitespaceOnly,
    Docs,
    Test,
    Config,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagram {
    /// Only `"mermaid"` for now.
    pub kind: String,
    pub source: String,
    pub caption: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalkthroughStep {
    pub title: String,
    pub why: String,
    pub hunk_ids: Vec<String>,
    pub diagram: Option<Diagram>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HunkAssessment {
    pub importance: Importance,
    pub rationale: String,
    #[serde(default)]
    pub concerns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuidedReview {
    pub schema_version: u32,
    pub summary: String,
    pub walkthrough: Vec<WalkthroughStep>,
    pub hunks: BTreeMap<String, HunkAssessment>,
    #[serde(default)]
    pub questions: Vec<String>,
}

impl GuidedReview {
    /// Hunk ids from the diff that the review fails to assess. A review with
    /// missing hunks must be rejected rather than silently rendered.
    pub fn missing_hunks<'a>(&self, diff_hunk_ids: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
        diff_hunk_ids
            .into_iter()
            .filter(|id| !self.hunks.contains_key(*id))
            .collect()
    }
}

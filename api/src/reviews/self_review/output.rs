//! The self-review output schema, and validation that pins every finding to
//! lines that really are in the diff.

use std::collections::HashMap;

use loupe_protocol::self_review::{Finding, LineSide, SELF_REVIEW_SCHEMA_VERSION, SelfReview, Severity};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::pulls::PullResponse;

pub const SCHEMA_NAME: &str = "self_review";

const MAX_FINDINGS: usize = 30;
const MAX_TEXT: usize = 4_000;
const MAX_SUGGESTION: usize = 8_000;

pub fn schema() -> Value {
    let string = json!({ "type": "string" });
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary", "findings"],
        "properties": {
            "summary": string,
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["hunk_id", "side", "start_line", "end_line", "severity", "title", "body", "suggestion"],
                    "properties": {
                        "hunk_id": string,
                        "side": { "type": "string", "enum": ["new", "old"] },
                        "start_line": { "type": "integer" },
                        "end_line": { "type": "integer" },
                        "severity": { "type": "string", "enum": ["blocker", "major", "minor", "nit"] },
                        "title": string,
                        "body": string,
                        "suggestion": { "type": ["string", "null"] }
                    }
                }
            }
        }
    })
}

#[derive(Deserialize)]
struct ModelReview {
    summary: String,
    findings: Vec<ModelFinding>,
}

#[derive(Deserialize)]
struct ModelFinding {
    hunk_id: String,
    side: LineSide,
    start_line: i64,
    end_line: i64,
    severity: Severity,
    title: String,
    body: String,
    suggestion: Option<String>,
}

/// Where a reviewable hunk sits in its file.
struct HunkRange<'a> {
    path: &'a str,
    old: (u32, u32),
    new: (u32, u32),
}

fn clip(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Parses the model's output. Findings on unknown hunks, or whose start line
/// isn't in the hunk, are dropped; end lines are clamped to the hunk.
pub fn parse(raw: &str, pr: &PullResponse) -> anyhow::Result<SelfReview> {
    let model: ModelReview = serde_json::from_str(raw)?;
    let hunks: HashMap<&str, HunkRange> = pr
        .files
        .iter()
        .flat_map(|f| f.analysis.hunks.iter().map(move |h| (f, h)))
        .filter(|(_, h)| !h.collapsible)
        .map(|(f, h)| {
            let range = |start: u32, lines: u32| (start, (start + lines).saturating_sub(1));
            (
                h.id.as_str(),
                HunkRange {
                    path: &f.file.filename,
                    old: range(h.old_start, h.old_lines),
                    new: range(h.new_start, h.new_lines),
                },
            )
        })
        .collect();

    let mut findings = Vec::new();
    for f in model.findings {
        if findings.len() == MAX_FINDINGS {
            break;
        }
        let Some(hunk) = hunks.get(f.hunk_id.as_str()) else {
            continue;
        };
        let (first, last) = match f.side {
            LineSide::New => hunk.new,
            LineSide::Old => hunk.old,
        };
        let start = f.start_line;
        if last < first || start < first as i64 || start > last as i64 {
            continue;
        }
        let end = f.end_line.clamp(start, last as i64);
        findings.push(Finding {
            id: format!("f{}", findings.len() + 1),
            path: hunk.path.to_owned(),
            side: f.side,
            start_line: start as u32,
            end_line: end as u32,
            severity: f.severity,
            title: clip(f.title, 200),
            body: clip(f.body, MAX_TEXT),
            suggestion: f
                .suggestion
                .filter(|s| !s.trim().is_empty())
                .map(|s| clip(s, MAX_SUGGESTION)),
        });
    }

    Ok(SelfReview {
        schema_version: SELF_REVIEW_SCHEMA_VERSION,
        summary: clip(model.summary, MAX_TEXT),
        findings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        prepass::{self, FileInput},
        pulls::{AnalyzedFile, Author, GitRef, Pull, PullFile},
    };

    fn pr() -> PullResponse {
        let patch = "@@ -10,2 +10,3 @@\n keep\n-old\n+new\n+more\n";
        let analysis = prepass::analyze(FileInput {
            filename: "src/a.rs",
            status: "modified",
            patch: Some(patch),
        });
        let git_ref = GitRef {
            name: "main".into(),
            sha: "s".into(),
            repo: None,
        };
        PullResponse {
            pull: Pull {
                number: 1,
                title: "t".into(),
                body: None,
                state: "open".into(),
                draft: None,
                html_url: String::new(),
                user: Author {
                    login: "a".into(),
                    avatar_url: None,
                },
                base: git_ref.clone(),
                head: git_ref,
            },
            files: vec![AnalyzedFile {
                file: PullFile {
                    filename: "src/a.rs".into(),
                    previous_filename: None,
                    status: "modified".into(),
                    additions: 2,
                    deletions: 1,
                    patch: Some(patch.into()),
                },
                analysis,
            }],
            truncated: false,
        }
    }

    fn finding(hunk_id: &str, side: &str, start: i64, end: i64) -> Value {
        json!({ "hunk_id": hunk_id, "side": side, "start_line": start, "end_line": end,
                "severity": "major", "title": "t", "body": "b", "suggestion": null })
    }

    #[test]
    fn pins_findings_to_hunk_lines() {
        let pr = pr();
        let id = pr.files[0].analysis.hunks[0].id.clone();
        let raw = json!({
            "summary": "s",
            "findings": [
                finding(&id, "new", 11, 99),   // end clamped to 12
                finding(&id, "old", 11, 11),   // the removed line
                finding(&id, "new", 30, 31),   // outside the hunk: dropped
                finding("h_unknown", "new", 10, 10),
            ]
        })
        .to_string();
        let review = parse(&raw, &pr).unwrap();
        assert_eq!(review.findings.len(), 2);
        assert_eq!((review.findings[0].start_line, review.findings[0].end_line), (11, 12));
        assert_eq!(review.findings[0].path, "src/a.rs");
        assert_eq!(review.findings[1].side, LineSide::Old);
        assert_eq!(review.findings[1].id, "f2");
    }
}

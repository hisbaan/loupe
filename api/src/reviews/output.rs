//! The JSON schema the model must follow, and validation of what it returns.
//!
//! Strict structured outputs don't allow maps or optional fields, so the model
//! produces arrays and nulls, which are converted into
//! [`loupe_protocol::review::GuidedReview`].

use std::collections::{BTreeMap, HashSet};

use anyhow::bail;
use loupe_protocol::review::{Diagram, GuidedReview, HunkAssessment, Importance, SCHEMA_VERSION, WalkthroughStep};
use serde::Deserialize;
use serde_json::{Value, json};

pub const SCHEMA_NAME: &str = "guided_review";

const MAX_STEPS: usize = 12;
const MAX_TEXT: usize = 4_000;
const MAX_DIAGRAM: usize = 8_000;

pub fn schema() -> Value {
    let string = json!({ "type": "string" });
    let strings = json!({ "type": "array", "items": string });
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary", "walkthrough", "hunks", "questions"],
        "properties": {
            "summary": string,
            "walkthrough": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["title", "why", "hunk_ids", "diagram"],
                    "properties": {
                        "title": string,
                        "why": string,
                        "hunk_ids": strings,
                        "diagram": {
                            "anyOf": [
                                {
                                    "type": "object",
                                    "additionalProperties": false,
                                    "required": ["source", "caption"],
                                    "properties": {
                                        "source": string,
                                        "caption": { "type": ["string", "null"] }
                                    }
                                },
                                { "type": "null" }
                            ]
                        }
                    }
                }
            },
            "hunks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["hunk_id", "importance", "rationale", "concerns"],
                    "properties": {
                        "hunk_id": string,
                        "importance": { "type": "string", "enum": ["critical", "normal", "low"] },
                        "rationale": string,
                        "concerns": strings
                    }
                }
            },
            "questions": strings
        }
    })
}

#[derive(Deserialize)]
struct ModelReview {
    summary: String,
    walkthrough: Vec<ModelStep>,
    hunks: Vec<ModelHunk>,
    questions: Vec<String>,
}

#[derive(Deserialize)]
struct ModelStep {
    title: String,
    why: String,
    hunk_ids: Vec<String>,
    diagram: Option<ModelDiagram>,
}

#[derive(Deserialize)]
struct ModelDiagram {
    source: String,
    caption: Option<String>,
}

#[derive(Deserialize)]
struct ModelHunk {
    hunk_id: String,
    importance: Importance,
    rationale: String,
    concerns: Vec<String>,
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

/// Parses and validates model output against the hunks it was asked about.
/// Unknown hunk ids are dropped; any missing hunk rejects the review.
pub fn parse(raw: &str, required_hunks: &[String]) -> anyhow::Result<GuidedReview> {
    let model: ModelReview = serde_json::from_str(raw)?;
    let known: HashSet<&str> = required_hunks.iter().map(String::as_str).collect();

    let mut hunks = BTreeMap::new();
    for h in model.hunks {
        if known.contains(h.hunk_id.as_str()) {
            hunks.insert(
                h.hunk_id,
                HunkAssessment {
                    importance: h.importance,
                    rationale: clip(h.rationale, MAX_TEXT),
                    concerns: h.concerns.into_iter().map(|c| clip(c, MAX_TEXT)).collect(),
                },
            );
        }
    }

    let walkthrough = model
        .walkthrough
        .into_iter()
        .take(MAX_STEPS)
        .map(|step| WalkthroughStep {
            title: clip(step.title, 200),
            why: clip(step.why, MAX_TEXT),
            hunk_ids: step
                .hunk_ids
                .into_iter()
                .filter(|id| known.contains(id.as_str()))
                .collect(),
            diagram: step
                .diagram
                .filter(|d| !d.source.trim().is_empty() && d.source.len() <= MAX_DIAGRAM)
                .map(|d| Diagram {
                    kind: "mermaid".into(),
                    source: d.source,
                    caption: d.caption.map(|c| clip(c, 300)),
                }),
        })
        .collect();

    let review = GuidedReview {
        schema_version: SCHEMA_VERSION,
        summary: clip(model.summary, MAX_TEXT),
        walkthrough,
        hunks,
        questions: model.questions.into_iter().map(|q| clip(q, MAX_TEXT)).collect(),
    };

    let missing = review.missing_hunks(required_hunks.iter().map(String::as_str));
    if !missing.is_empty() {
        bail!("the model skipped {} of {} hunks", missing.len(), required_hunks.len());
    }
    Ok(review)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(hunks: &[&str]) -> String {
        json!({
            "summary": "Adds a thing.",
            "walkthrough": [{ "title": "Core", "why": "Logic", "hunk_ids": ["h_a", "h_zzz"], "diagram": null }],
            "hunks": hunks.iter().map(|id| json!({
                "hunk_id": id, "importance": "critical", "rationale": "r", "concerns": []
            })).collect::<Vec<_>>(),
            "questions": []
        })
        .to_string()
    }

    #[test]
    fn accepts_complete_review_and_drops_unknown_ids() {
        let required = vec!["h_a".to_owned(), "h_b".to_owned()];
        let review = parse(&output(&["h_a", "h_b", "h_zzz"]), &required).unwrap();
        assert_eq!(review.hunks.len(), 2);
        assert_eq!(review.walkthrough[0].hunk_ids, vec!["h_a"]);
    }

    #[test]
    fn rejects_missing_hunks() {
        let required = vec!["h_a".to_owned(), "h_b".to_owned()];
        let err = parse(&output(&["h_a"]), &required).unwrap_err();
        assert!(err.to_string().contains("skipped 1 of 2"));
    }

    #[test]
    fn schema_is_strict_compatible() {
        // Strict mode: every object lists all its properties as required.
        fn check(v: &Value) {
            if let Some(props) = v.get("properties").and_then(Value::as_object) {
                let required: Vec<&str> = v["required"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| r.as_str().unwrap())
                    .collect();
                assert_eq!(v["additionalProperties"], false);
                for key in props.keys() {
                    assert!(required.contains(&key.as_str()), "{key} not required");
                }
            }
            match v {
                Value::Object(map) => map.values().for_each(check),
                Value::Array(items) => items.iter().for_each(check),
                _ => {}
            }
        }
        check(&schema());
    }
}

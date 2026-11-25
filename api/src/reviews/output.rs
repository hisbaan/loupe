//! The JSON schema the model must follow, and validation of what it returns.
//!
//! Strict structured outputs don't allow maps or optional fields, so the model
//! produces arrays and nulls, which are converted into
//! [`loupe_protocol::review::Review`].

use std::collections::{BTreeMap, HashMap, HashSet};

use loupe_protocol::review::{
    Attention, Category, Diagram, Finding, LineSide, Review, SCHEMA_VERSION, Section, Severity,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    job::Rejection,
    prompt::{Carried, Prompt},
};
use crate::pulls::PullResponse;

pub const SCHEMA_NAME: &str = "review";

const MAX_SECTIONS: usize = 12;
const MAX_FINDINGS: usize = 30;
const MAX_TEXT: usize = 4_000;
const MAX_NOTE: usize = 1_000;
const MAX_SUGGESTION: usize = 8_000;
const MAX_DIAGRAM: usize = 8_000;

pub fn schema() -> Value {
    let string = json!({ "type": "string" });
    let strings = json!({ "type": "array", "items": string });
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary", "sections", "findings", "hunk_notes", "questions"],
        "properties": {
            "summary": string,
            "sections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["title", "attention", "overview", "hunk_ids", "diagram"],
                    "properties": {
                        "title": string,
                        "attention": { "type": "string", "enum": ["review_closely", "read", "skim"] },
                        "overview": string,
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
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "hunk_id", "side", "start_line", "end_line", "severity", "category", "title", "body", "suggestion"
                    ],
                    "properties": {
                        "hunk_id": string,
                        "side": { "type": "string", "enum": ["new", "old"] },
                        "start_line": { "type": "integer" },
                        "end_line": { "type": "integer" },
                        "severity": { "type": "string", "enum": ["blocker", "major", "minor", "nit"] },
                        "category": {
                            "type": "string",
                            "enum": [
                                "bug", "security", "performance", "design", "convention", "test", "question", "suspicious"
                            ]
                        },
                        "title": string,
                        "body": string,
                        "suggestion": { "type": ["string", "null"] }
                    }
                }
            },
            "hunk_notes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["hunk_id", "note"],
                    "properties": { "hunk_id": string, "note": string }
                }
            },
            "questions": strings
        }
    })
}

#[derive(Deserialize)]
struct ModelReview {
    summary: String,
    sections: Vec<ModelSection>,
    findings: Vec<ModelFinding>,
    hunk_notes: Vec<ModelNote>,
    questions: Vec<String>,
}

#[derive(Deserialize)]
struct ModelSection {
    title: String,
    attention: Attention,
    overview: String,
    hunk_ids: Vec<String>,
    diagram: Option<ModelDiagram>,
}

#[derive(Deserialize)]
struct ModelDiagram {
    source: String,
    caption: Option<String>,
}

#[derive(Deserialize)]
struct ModelFinding {
    hunk_id: String,
    side: LineSide,
    start_line: i64,
    end_line: i64,
    severity: Severity,
    category: Category,
    title: String,
    body: String,
    suggestion: Option<String>,
}

#[derive(Deserialize)]
struct ModelNote {
    hunk_id: String,
    note: String,
}

/// Why a review was rejected.
#[derive(Debug, thiserror::Error)]
pub enum Invalid {
    #[error("the model's output didn't match the schema ({0})")]
    Malformed(#[from] serde_json::Error),
    /// Sections left out some hunks; worth asking the model to fix.
    #[error("the model left {} of {total} changes out of the review", missing.len())]
    MissingHunks { missing: Vec<String>, total: usize },
}

impl Invalid {
    /// Missing hunks are worth asking the model to fix; malformed output isn't.
    pub fn rejection(self) -> Rejection {
        let error = format!("The model's review was invalid: {self}.");
        match self {
            Self::MissingHunks { missing, .. } => Rejection::Repair {
                message: format!(
                    "Your review left these hunks out of every section: {}. Answer again with the complete review, \
                     placing every hunk listed under \"Hunks\" in exactly one section.",
                    missing.join(", ")
                ),
                error,
            },
            Self::Malformed(_) => Rejection::Fail(error),
        }
    }
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

/// Parses and validates the model's review.
///
/// - Sections must place every hunk in `prompt.hunks`; unknown ids are dropped
///   and a hunk listed twice stays in its first section.
/// - Findings and notes count only on hunks shown with code; findings must
///   start inside their hunk on the side they name, and end lines are clamped.
/// - `carried` findings and notes (from an earlier review, on unchanged hunks)
///   are kept as they were.
pub fn parse(raw: &str, pr: &PullResponse, prompt: &Prompt, carried: &Carried) -> Result<Review, Invalid> {
    let model: ModelReview = serde_json::from_str(raw)?;
    let placeable: HashSet<&str> = prompt.hunks.iter().map(String::as_str).collect();
    let shown: HashSet<&str> = prompt.shown.iter().map(String::as_str).collect();
    let ranges: HashMap<&str, HunkRange> = pr
        .files
        .iter()
        .flat_map(|f| f.analysis.hunks.iter().map(move |h| (f, h)))
        .filter(|(_, h)| shown.contains(h.id.as_str()))
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

    let mut placed = HashSet::new();
    let sections: Vec<Section> = model
        .sections
        .into_iter()
        .take(MAX_SECTIONS)
        .map(|s| Section {
            title: clip(s.title, 200),
            attention: s.attention,
            overview: clip(s.overview, MAX_TEXT),
            hunk_ids: s
                .hunk_ids
                .into_iter()
                .filter(|id| placeable.contains(id.as_str()) && placed.insert(id.clone()))
                .collect(),
            diagram: s
                .diagram
                .filter(|d| !d.source.trim().is_empty() && d.source.len() <= MAX_DIAGRAM)
                .map(|d| Diagram {
                    kind: "mermaid".into(),
                    source: d.source,
                    caption: d.caption.map(|c| clip(c, 300)),
                }),
        })
        .filter(|s| !s.hunk_ids.is_empty())
        .collect();

    let mut findings = Vec::new();
    for f in model.findings {
        if findings.len() == MAX_FINDINGS {
            break;
        }
        let Some(hunk) = ranges.get(f.hunk_id.as_str()) else {
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
            id: String::new(),
            path: hunk.path.to_owned(),
            hunk_id: f.hunk_id,
            side: f.side,
            start_line: start as u32,
            end_line: end as u32,
            severity: f.severity,
            category: f.category,
            title: clip(f.title, 200),
            body: clip(f.body, MAX_TEXT),
            suggestion: f
                .suggestion
                .filter(|s| !s.trim().is_empty())
                .map(|s| clip(s, MAX_SUGGESTION)),
        });
    }
    findings.extend(carried.findings.iter().cloned());
    for (i, finding) in findings.iter_mut().enumerate() {
        finding.id = format!("f{}", i + 1);
    }

    let mut hunk_notes: BTreeMap<String, String> = carried.notes.clone();
    for n in model.hunk_notes {
        if shown.contains(n.hunk_id.as_str()) && !n.note.trim().is_empty() {
            hunk_notes.insert(n.hunk_id, clip(n.note, MAX_NOTE));
        }
    }

    let review = Review {
        schema_version: SCHEMA_VERSION,
        summary: clip(model.summary, MAX_TEXT),
        sections,
        findings,
        hunk_notes,
        questions: model.questions.into_iter().map(|q| clip(q, MAX_TEXT)).collect(),
    };

    let missing = review.missing_hunks(prompt.hunks.iter().map(String::as_str));
    if !missing.is_empty() {
        return Err(Invalid::MissingHunks {
            missing: missing.into_iter().map(str::to_owned).collect(),
            total: prompt.hunks.len(),
        });
    }
    Ok(review)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reviews::prompt::{
        self,
        tests::{file, pr},
    };

    fn setup() -> (PullResponse, Prompt, String) {
        let pr = pr(vec![file("src/a.rs", "@@ -10,2 +10,3 @@\n keep\n-old\n+new\n+more\n")]);
        let prompt = prompt::build(&pr, None, None).unwrap();
        let id = prompt.hunks[0].clone();
        (pr, prompt, id)
    }

    fn section(ids: &[&str]) -> Value {
        json!({ "title": "Core", "attention": "review_closely", "overview": "o", "hunk_ids": ids, "diagram": null })
    }

    fn finding(hunk_id: &str, side: &str, start: i64, end: i64) -> Value {
        json!({ "hunk_id": hunk_id, "side": side, "start_line": start, "end_line": end,
                "severity": "major", "category": "bug", "title": "t", "body": "b", "suggestion": null })
    }

    fn output(sections: Vec<Value>, findings: Vec<Value>, notes: Vec<Value>) -> String {
        json!({ "summary": "s", "sections": sections, "findings": findings, "hunk_notes": notes, "questions": [] })
            .to_string()
    }

    #[test]
    fn places_hunks_and_drops_unknown_ids() {
        let (pr, prompt, id) = setup();
        let raw = output(
            vec![section(&[&id, "h_zzz"]), section(&[&id]), section(&["h_zzz"])],
            vec![],
            vec![],
        );
        let review = parse(&raw, &pr, &prompt, &Carried::default()).unwrap();
        // The duplicate and the section left empty are dropped.
        assert_eq!(review.sections.len(), 1);
        assert_eq!(review.sections[0].hunk_ids, vec![id]);
    }

    #[test]
    fn rejects_missing_hunks() {
        let (pr, prompt, id) = setup();
        let raw = output(vec![section(&["h_zzz"])], vec![], vec![]);
        match parse(&raw, &pr, &prompt, &Carried::default()) {
            Err(Invalid::MissingHunks { missing, total }) => assert_eq!((missing, total), (vec![id], 1)),
            other => panic!("expected missing hunks, got {other:?}"),
        }
    }

    #[test]
    fn pins_findings_to_hunk_lines() {
        let (pr, prompt, id) = setup();
        let raw = output(
            vec![section(&[&id])],
            vec![
                finding(&id, "new", 11, 99), // end clamped to 12
                finding(&id, "old", 11, 11), // the removed line
                finding(&id, "new", 30, 31), // outside the hunk: dropped
                finding("h_unknown", "new", 10, 10),
            ],
            vec![
                json!({ "hunk_id": id, "note": "n" }),
                json!({ "hunk_id": "h_unknown", "note": "n" }),
            ],
        );
        let review = parse(&raw, &pr, &prompt, &Carried::default()).unwrap();
        assert_eq!(review.findings.len(), 2);
        assert_eq!((review.findings[0].start_line, review.findings[0].end_line), (11, 12));
        assert_eq!(review.findings[0].path, "src/a.rs");
        assert_eq!(review.findings[1].side, LineSide::Old);
        assert_eq!(review.findings[1].id, "f2");
        assert_eq!(review.hunk_notes.keys().collect::<Vec<_>>(), vec![&id]);
    }

    #[test]
    fn keeps_carried_findings_and_notes() {
        let pr = pr(vec![
            file("a.rs", "@@ -1 +1 @@\n-old_a\n+new_a\n"),
            file("b.rs", "@@ -1 +1 @@\n-old_b\n+new_b\n"),
        ]);
        let unchanged = pr.files[0].analysis.hunks[0].id.clone();
        let changed = pr.files[1].analysis.hunks[0].id.clone();
        let earlier = Finding {
            id: "f9".into(),
            hunk_id: unchanged.clone(),
            path: "a.rs".into(),
            side: LineSide::New,
            start_line: 1,
            end_line: 1,
            severity: Severity::Minor,
            category: Category::Design,
            title: "old".into(),
            body: "b".into(),
            suggestion: None,
        };
        let carried = Carried {
            findings: vec![earlier],
            notes: BTreeMap::from([(unchanged.clone(), "kept".to_owned())]),
            hunks: vec![unchanged.clone()],
        };
        let previous = prompt::Previous {
            head_sha: "abc",
            summary: "s",
            carried: &carried,
        };
        let prompt = prompt::build(&pr, Some(&previous), None).unwrap();
        // The model can't add findings or notes to the unchanged hunk.
        let raw = output(
            vec![section(&[&changed, &unchanged])],
            vec![finding(&unchanged, "new", 1, 1), finding(&changed, "new", 1, 1)],
            vec![json!({ "hunk_id": unchanged, "note": "replaced" })],
        );
        let review = parse(&raw, &pr, &prompt, &carried).unwrap();
        let titles: Vec<(&str, &str)> = review
            .findings
            .iter()
            .map(|f| (f.id.as_str(), f.hunk_id.as_str()))
            .collect();
        assert_eq!(titles, vec![("f1", changed.as_str()), ("f2", unchanged.as_str())]);
        assert_eq!(review.hunk_notes[&unchanged], "kept");
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

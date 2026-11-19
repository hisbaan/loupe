//! Read-only repository tools the model can call while reviewing. They run
//! in-process against a [`Reader`] bound to the job's repository and commits;
//! the model only picks a side, paths and a search pattern. Nothing here
//! executes anything.
//!
//! Every call and every byte of output counts against a per-review budget,
//! because the whole conversation is resent on each turn.

use std::fmt::Write;

use futures_util::future::join_all;
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::source::{Entry, MAX_BLOB_BYTES, Reader, Side, Tree};

pub const MAX_CALLS: usize = 25;
const MAX_OUTPUT_BYTES: usize = 150_000;
const MAX_LIST_ENTRIES: usize = 300;
const MAX_READ_LINES: usize = 400;
const MAX_READ_BYTES: usize = 40_000;
const MAX_GREP_FILES: usize = 200;
const MAX_GREP_FILE_BYTES: u64 = 256 * 1024;
const MAX_GREP_MATCHES: usize = 80;
const MAX_LINE_CHARS: usize = 240;
const GREP_CONCURRENCY: usize = 8;

/// Function tool definitions for the Responses API (strict schemas).
pub fn definitions() -> Vec<Value> {
    let side = json!({
        "type": "string",
        "enum": ["base", "head"],
        "description": "base is the target branch before the change; head is the pull request's version.",
    });
    let prefix = json!({
        "type": ["string", "null"],
        "description": "Directory to restrict to, e.g. \"src/api\"; null for the whole repository.",
    });
    let function = |name: &str, description: &str, properties: Value, required: &[&str]| {
        json!({
            "type": "function",
            "name": name,
            "description": description,
            "strict": true,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false,
            },
        })
    };
    vec![
        function(
            "list_files",
            "List files in the repository, or in one directory. Large directories are summarised by subdirectory.",
            json!({ "side": side, "path_prefix": prefix }),
            &["side", "path_prefix"],
        ),
        function(
            "read_file",
            "Read a file with line numbers. Reads up to 400 lines per call; use start_line and end_line for more.",
            json!({
                "side": side,
                "path": { "type": "string", "description": "Path from the repository root." },
                "start_line": { "type": ["integer", "null"], "description": "First line, 1-based; null for 1." },
                "end_line": { "type": ["integer", "null"], "description": "Last line, inclusive; null for as many as allowed." },
            }),
            &["side", "path", "start_line", "end_line"],
        ),
        function(
            "grep",
            "Search file contents with a regular expression (Rust regex syntax, case-sensitive). Returns matching lines with paths and line numbers. Narrow with path_prefix in large repositories.",
            json!({
                "side": side,
                "pattern": { "type": "string" },
                "path_prefix": prefix,
            }),
            &["side", "pattern", "path_prefix"],
        ),
    ]
}

#[derive(Deserialize)]
struct ListArgs {
    side: Side,
    path_prefix: Option<String>,
}

#[derive(Deserialize)]
struct ReadArgs {
    side: Side,
    path: String,
    start_line: Option<i64>,
    end_line: Option<i64>,
}

#[derive(Deserialize)]
struct GrepArgs {
    side: Side,
    pattern: String,
    path_prefix: Option<String>,
}

pub struct Toolbox<R> {
    reader: R,
    calls: usize,
    output_bytes: usize,
}

impl<R: Reader> Toolbox<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            calls: 0,
            output_bytes: 0,
        }
    }

    pub fn exhausted(&self) -> bool {
        self.calls >= MAX_CALLS || self.output_bytes >= MAX_OUTPUT_BYTES
    }

    /// A short progress message for a call, e.g. "Reading src/main.rs".
    pub fn describe(name: &str, arguments: &str) -> String {
        let args: Value = serde_json::from_str(arguments).unwrap_or_default();
        let text = |key: &str| args[key].as_str().map(|s| s.chars().take(80).collect::<String>());
        match name {
            "read_file" => format!("Reading {}", text("path").unwrap_or_default()),
            "grep" => format!("Searching for {}", text("pattern").unwrap_or_default()),
            "list_files" => match text("path_prefix") {
                Some(prefix) => format!("Listing {prefix}"),
                None => "Listing files".into(),
            },
            _ => "Using a tool".into(),
        }
    }

    /// Runs one call. Problems are reported to the model as text so it can
    /// correct itself; nothing here fails the review.
    pub async fn call(&mut self, name: &str, arguments: &str) -> String {
        if self.exhausted() {
            return "Tool budget used up. Finish the review with what you have.".into();
        }
        self.calls += 1;
        let result = match name {
            "list_files" => match serde_json::from_str(arguments) {
                Ok(args) => self.list_files(args).await,
                Err(err) => Err(format!("invalid arguments: {err}")),
            },
            "read_file" => match serde_json::from_str(arguments) {
                Ok(args) => self.read_file(args).await,
                Err(err) => Err(format!("invalid arguments: {err}")),
            },
            "grep" => match serde_json::from_str(arguments) {
                Ok(args) => self.grep(args).await,
                Err(err) => Err(format!("invalid arguments: {err}")),
            },
            _ => Err(format!("unknown tool {name}")),
        };
        let mut output = result.unwrap_or_else(|err| format!("Error: {err}"));

        let remaining = MAX_OUTPUT_BYTES.saturating_sub(self.output_bytes);
        if output.len() > remaining {
            output.truncate(floor_char_boundary(&output, remaining));
            output.push_str("\n[output cut off: tool output budget used up]");
        }
        self.output_bytes += output.len();
        output
    }

    async fn tree(&self, side: Side) -> Result<std::sync::Arc<Tree>, String> {
        self.reader
            .tree(side)
            .await
            .map_err(|err| format!("couldn't load the {} tree ({err})", side.as_str()))
    }

    async fn list_files(&self, args: ListArgs) -> Result<String, String> {
        let tree = self.tree(args.side).await?;
        let prefix = crate::source::normalize(args.path_prefix.as_deref().unwrap_or(""));
        let entries: Vec<&Entry> = tree.under(prefix).collect();
        let place = if prefix.is_empty() {
            "the repository".to_owned()
        } else {
            prefix.to_owned()
        };

        let mut out = String::new();
        if entries.is_empty() {
            let _ = write!(out, "No files in {place} on {}.", args.side.as_str());
        } else if entries.len() <= MAX_LIST_ENTRIES {
            let _ = writeln!(out, "{} files in {place} on {}:", entries.len(), args.side.as_str());
            for e in &entries {
                let _ = writeln!(out, "{} ({} bytes)", e.path, e.size);
            }
        } else {
            // Too many to list: summarise by the next path component.
            let mut groups: Vec<(String, usize)> = Vec::new();
            for e in &entries {
                let rest = e.path[prefix.len()..].trim_start_matches('/');
                let key = match rest.split_once('/') {
                    Some((dir, _)) => format!("{dir}/"),
                    None => rest.to_owned(),
                };
                match groups.last_mut() {
                    Some((last, count)) if *last == key => *count += 1,
                    _ => groups.push((key, 1)),
                }
            }
            let _ = writeln!(
                out,
                "{} files in {place} on {}; too many to list, so grouped by directory:",
                entries.len(),
                args.side.as_str()
            );
            for (key, count) in groups.iter().take(MAX_LIST_ENTRIES) {
                if key.ends_with('/') {
                    let _ = writeln!(out, "{key} ({count} files)");
                } else {
                    let _ = writeln!(out, "{key}");
                }
            }
            if groups.len() > MAX_LIST_ENTRIES {
                let _ = writeln!(out, "... and {} more", groups.len() - MAX_LIST_ENTRIES);
            }
        }
        if tree.truncated {
            out.push_str("\n(GitHub truncated this repository's file list, so some files may be missing.)");
        }
        Ok(out)
    }

    async fn read_file(&self, args: ReadArgs) -> Result<String, String> {
        let tree = self.tree(args.side).await?;
        let entry = tree.get(&args.path).ok_or_else(|| {
            format!(
                "no file at {} on {}. Use list_files to find paths.",
                args.path,
                args.side.as_str()
            )
        })?;
        if entry.size > MAX_BLOB_BYTES {
            return Err(format!("{} is too large to read ({} bytes)", entry.path, entry.size));
        }
        let blob = self
            .reader
            .blob(entry)
            .await
            .map_err(|err| format!("couldn't read {}: {err}", entry.path))?;
        let text = as_text(&blob).ok_or_else(|| format!("{} is a binary file", entry.path))?;

        let lines: Vec<&str> = text.lines().collect();
        let total = lines.len();
        let start = args.start_line.unwrap_or(1).max(1) as usize;
        if start > total.max(1) {
            return Err(format!("{} has only {total} lines", entry.path));
        }
        let end = args
            .end_line
            .map(|e| e.max(0) as usize)
            .unwrap_or(usize::MAX)
            .min(total)
            .min(start + MAX_READ_LINES - 1);

        let mut out = format!("{} on {} ({total} lines)\n", entry.path, args.side.as_str());
        let mut last = start.saturating_sub(1);
        for (i, line) in lines.iter().enumerate().take(end).skip(start - 1) {
            if out.len() + line.len() > MAX_READ_BYTES {
                break;
            }
            let _ = writeln!(out, "{:>5}| {}", i + 1, clip(line, 1000));
            last = i + 1;
        }
        if last < total {
            let _ = write!(
                out,
                "[lines {start}-{last} of {total}; call again with start_line={}]",
                last + 1
            );
        }
        Ok(out)
    }

    async fn grep(&self, args: GrepArgs) -> Result<String, String> {
        let regex = RegexBuilder::new(&args.pattern)
            .size_limit(1 << 20)
            .dfa_size_limit(1 << 20)
            .build()
            .map_err(|err| format!("invalid pattern: {err}"))?;
        let tree = self.tree(args.side).await?;
        let prefix = crate::source::normalize(args.path_prefix.as_deref().unwrap_or(""));
        let candidates: Vec<&Entry> = tree.under(prefix).filter(|e| e.size <= MAX_GREP_FILE_BYTES).collect();
        let searched = candidates.len().min(MAX_GREP_FILES);

        let candidates_searched = &candidates[..searched];
        let mut blobs = Vec::with_capacity(searched);
        for chunk in candidates_searched.chunks(GREP_CONCURRENCY) {
            let reads: Vec<_> = chunk.iter().map(|e| self.reader.blob(e)).collect();
            blobs.extend(chunk.iter().copied().zip(join_all(reads).await));
        }

        let mut out = String::new();
        let mut matches = 0;
        let mut unreadable = 0;
        'files: for (entry, blob) in blobs {
            let Ok(blob) = blob else {
                unreadable += 1;
                continue;
            };
            let Some(text) = as_text(&blob) else { continue };
            for (i, line) in text.lines().enumerate() {
                if regex.is_match(line) {
                    if matches == MAX_GREP_MATCHES {
                        out.push_str("[more matches not shown; narrow the pattern or path_prefix]\n");
                        break 'files;
                    }
                    let _ = writeln!(out, "{}:{}: {}", entry.path, i + 1, clip(line.trim(), MAX_LINE_CHARS));
                    matches += 1;
                }
            }
        }

        let mut header = format!("{matches} matches on {}", args.side.as_str());
        if candidates.len() > searched {
            let _ = write!(
                header,
                "; searched the first {searched} of {} files, so narrow path_prefix to search the rest",
                candidates.len()
            );
        }
        if unreadable > 0 {
            let _ = write!(header, "; {unreadable} files couldn't be read");
        }
        Ok(format!("{header}\n{out}"))
    }
}

/// UTF-8 text, or `None` for binary content.
fn as_text(bytes: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(bytes).ok()?;
    (!text.contains('\0')).then_some(text)
}

fn clip(line: &str, max_chars: usize) -> String {
    if line.chars().count() <= max_chars {
        return line.to_owned();
    }
    let mut clipped: String = line.chars().take(max_chars).collect();
    clipped.push('…');
    clipped
}

fn floor_char_boundary(s: &str, mut index: usize) -> usize {
    while !s.is_char_boundary(index) {
        index -= 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc};

    use super::*;
    use crate::error::{AppError, AppResult};

    struct FakeReader {
        head: Arc<Tree>,
        blobs: HashMap<String, Vec<u8>>,
    }

    impl Reader for FakeReader {
        async fn tree(&self, side: Side) -> AppResult<Arc<Tree>> {
            match side {
                Side::Head => Ok(self.head.clone()),
                Side::Base => Ok(Arc::new(Tree::default())),
            }
        }

        async fn blob(&self, entry: &Entry) -> AppResult<Arc<Vec<u8>>> {
            self.blobs
                .get(&entry.sha)
                .map(|b| Arc::new(b.clone()))
                .ok_or(AppError::NotFound)
        }
    }

    fn toolbox(files: &[(&str, &str)]) -> Toolbox<FakeReader> {
        let entries = files
            .iter()
            .map(|(path, content)| Entry {
                path: (*path).into(),
                sha: (*path).into(),
                size: content.len() as u64,
            })
            .collect();
        let blobs = files
            .iter()
            .map(|(p, c)| ((*p).to_owned(), c.as_bytes().to_vec()))
            .collect();
        Toolbox::new(FakeReader {
            head: Arc::new(Tree::new(entries, false)),
            blobs,
        })
    }

    #[test]
    fn definitions_are_strict() {
        for tool in definitions() {
            let params = &tool["parameters"];
            let properties: Vec<_> = params["properties"].as_object().unwrap().keys().cloned().collect();
            let mut required: Vec<String> = serde_json::from_value(params["required"].clone()).unwrap();
            required.sort();
            let mut properties = properties;
            properties.sort();
            assert_eq!(required, properties, "{}", tool["name"]);
        }
    }

    #[tokio::test]
    async fn reads_numbered_ranges() {
        let mut tools = toolbox(&[("src/lib.rs", "one\ntwo\nthree\n")]);
        let out = tools
            .call(
                "read_file",
                r#"{"side":"head","path":"./src/lib.rs","start_line":2,"end_line":2}"#,
            )
            .await;
        assert!(out.contains("    2| two"), "{out}");
        assert!(!out.contains("one"));
        assert!(out.contains("start_line=3"));
    }

    #[tokio::test]
    async fn reports_missing_and_binary_files() {
        let mut tools = toolbox(&[("logo.png", "\u{0}PNG")]);
        let missing = tools
            .call(
                "read_file",
                r#"{"side":"head","path":"nope.rs","start_line":null,"end_line":null}"#,
            )
            .await;
        assert!(missing.starts_with("Error: no file"));
        let binary = tools
            .call(
                "read_file",
                r#"{"side":"head","path":"logo.png","start_line":null,"end_line":null}"#,
            )
            .await;
        assert!(binary.contains("binary"));
    }

    #[tokio::test]
    async fn greps_within_a_directory() {
        let mut tools = toolbox(&[
            ("src/a.rs", "fn handler() {}\nfn other() {}"),
            ("src/b.rs", "handler();"),
            ("docs/x.md", "handler"),
        ]);
        let out = tools
            .call("grep", r#"{"side":"head","pattern":"handler\\(","path_prefix":"src"}"#)
            .await;
        assert!(out.starts_with("2 matches"), "{out}");
        assert!(out.contains("src/a.rs:1: fn handler() {}"));
        assert!(!out.contains("docs/"));
        let bad = tools
            .call("grep", r#"{"side":"head","pattern":"(","path_prefix":null}"#)
            .await;
        assert!(bad.starts_with("Error: invalid pattern"));
    }

    #[tokio::test]
    async fn summarises_large_listings() {
        let files: Vec<(String, String)> = (0..400)
            .map(|i| (format!("gen/{}/f{i}.rs", i % 3), String::new()))
            .collect();
        let refs: Vec<(&str, &str)> = files.iter().map(|(p, c)| (p.as_str(), c.as_str())).collect();
        let mut tools = toolbox(&refs);
        let out = tools.call("list_files", r#"{"side":"head","path_prefix":"gen"}"#).await;
        assert!(out.contains("grouped by directory"), "{out}");
        assert!(out.contains("0/ (134 files)"));
    }

    #[tokio::test]
    async fn enforces_the_call_budget() {
        let mut tools = toolbox(&[]);
        for _ in 0..MAX_CALLS {
            tools.call("list_files", r#"{"side":"base","path_prefix":null}"#).await;
        }
        assert!(tools.exhausted());
        assert!(tools.call("list_files", "{}").await.contains("budget used up"));
    }
}

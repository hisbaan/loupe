//! Deterministic pre-pass over a pull request diff.
//!
//! Labels every hunk with a [`HunkKind`] and decides whether it may be
//! collapsed without the model's input. The PR author controls everything this
//! module reads, so it errs one way only: a false "collapsible" can hide code
//! from a reviewer, while a false "code" just costs a little attention. When in
//! doubt, classify as [`HunkKind::Code`].

mod hunks;
mod imports;
mod lockfile;
mod paths;
mod whitespace;

use loupe_protocol::{hunk::hunk_id, review::HunkKind};
use serde::Serialize;

use self::{
    hunks::{Hunk, Line, parse_hunks},
    paths::PathClass,
};

/// Minimal view of a changed file; mirrors GitHub's pull request file entry.
pub struct FileInput<'a> {
    pub filename: &'a str,
    pub status: &'a str,
    pub patch: Option<&'a str>,
}

#[derive(Debug, Serialize)]
pub struct HunkAnalysis {
    pub id: String,
    /// The `@@ ... @@` line, so clients can check they split the patch the same way.
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub kind: HunkKind,
    pub collapsible: bool,
    /// Why something that looks collapsible isn't, or anything else a reviewer
    /// should see.
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct FileAnalysis {
    /// File-level label (e.g. lockfile, test, docs), if any.
    pub kind: Option<HunkKind>,
    /// True when there is nothing in the file that needs review: every hunk is
    /// collapsible, or it is a pure rename.
    pub collapsible: bool,
    pub hunks: Vec<HunkAnalysis>,
}

pub fn analyze(file: FileInput<'_>) -> FileAnalysis {
    let class = paths::classify(file.filename);
    let added_file = file.status == "added";

    let Some(patch) = file.patch.filter(|p| !p.trim().is_empty()) else {
        // No textual diff: pure renames are safe to collapse; binaries and
        // oversized diffs are not something we can vouch for.
        let rename = matches!(file.status, "renamed" | "copied");
        return FileAnalysis {
            kind: if rename { Some(HunkKind::Rename) } else { class.label() },
            collapsible: rename,
            hunks: Vec::new(),
        };
    };

    let hunks: Vec<HunkAnalysis> = parse_hunks(patch)
        .into_iter()
        .map(|hunk| analyze_hunk(file.filename, &class, added_file, hunk))
        .collect();

    FileAnalysis {
        kind: class.label(),
        collapsible: !hunks.is_empty() && hunks.iter().all(|h| h.collapsible),
        hunks,
    }
}

fn analyze_hunk(path: &str, class: &PathClass, added_file: bool, hunk: Hunk<'_>) -> HunkAnalysis {
    let mut notes = Vec::new();
    let (kind, collapsible) = classify_hunk(path, class, added_file, &hunk, &mut notes);
    HunkAnalysis {
        id: hunk_id(path, hunk.text),
        header: hunk.header.to_owned(),
        old_start: hunk.old_start,
        old_lines: hunk.old_lines,
        new_start: hunk.new_start,
        new_lines: hunk.new_lines,
        kind,
        collapsible,
        notes,
    }
}

fn classify_hunk(
    path: &str,
    class: &PathClass,
    added_file: bool,
    hunk: &Hunk<'_>,
    notes: &mut Vec<String>,
) -> (HunkKind, bool) {
    if class.lockfile {
        let suspicious = lockfile::unusual_sources(hunk.added());
        if suspicious.is_empty() {
            return (HunkKind::Lockfile, true);
        }
        for source in suspicious {
            notes.push(format!("Dependency resolved from an unusual source: {source}"));
        }
        return (HunkKind::Lockfile, false);
    }

    if class.vendored {
        return (HunkKind::Vendored, true);
    }

    // Generated-ness is claimed by the PR author (file name or a marker
    // comment), so only trust it for files that were already generated.
    let marker = generated_marker(hunk);
    if class.generated || marker != Marker::None {
        if added_file {
            notes.push("New file that claims to be generated; shown because it didn't exist before".into());
            return (HunkKind::Generated, false);
        }
        if marker == Marker::Added {
            notes.push("This change marks the file as generated; shown because the marker is new".into());
            return (HunkKind::Generated, false);
        }
        return (HunkKind::Generated, true);
    }

    if whitespace::only_whitespace(path, hunk) {
        return (HunkKind::WhitespaceOnly, true);
    }

    if imports::only_imports(path, hunk) {
        return (HunkKind::ImportOnly, true);
    }

    (class.label().unwrap_or(HunkKind::Code), false)
}

#[derive(Debug, PartialEq, Eq)]
enum Marker {
    None,
    /// Present before this change (context or removed-and-re-added line).
    Existing,
    /// Only appears on added lines.
    Added,
}

/// Looks for a "generated file" header near the top of the file.
fn generated_marker(hunk: &Hunk<'_>) -> Marker {
    const HEADER_LINES: u32 = 10;
    if hunk.new_start > HEADER_LINES && hunk.old_start > HEADER_LINES {
        return Marker::None;
    }
    let is_marker = |text: &str| {
        let lower = text.to_ascii_lowercase();
        lower.contains("@generated")
            || (lower.contains("code generated") && lower.contains("do not edit"))
            || lower.contains("auto-generated")
            || lower.contains("autogenerated")
            || lower.contains("this file was automatically generated")
    };

    let mut old_side = false;
    let mut new_side = false;
    for (line, old_no, new_no) in hunk.numbered() {
        match line {
            Line::Context(t) if new_no <= HEADER_LINES && is_marker(t) => {
                old_side = true;
                new_side = true;
            }
            Line::Removed(t) if old_no <= HEADER_LINES && is_marker(t) => old_side = true,
            Line::Added(t) if new_no <= HEADER_LINES && is_marker(t) => new_side = true,
            _ => {}
        }
    }
    match (old_side, new_side) {
        (true, true) => Marker::Existing,
        (false, true) => Marker::Added,
        // Marker removed: the file is no longer generated, so review it.
        _ => Marker::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file<'a>(filename: &'a str, status: &'a str, patch: &'a str) -> FileAnalysis {
        analyze(FileInput {
            filename,
            status,
            patch: Some(patch),
        })
    }

    #[test]
    fn plain_code_is_not_collapsible() {
        let a = file(
            "src/lib.rs",
            "modified",
            "@@ -1,2 +1,2 @@\n fn main() {\n-    a();\n+    b();\n",
        );
        assert_eq!(a.hunks[0].kind, HunkKind::Code);
        assert!(!a.hunks[0].collapsible);
        assert!(!a.collapsible);
    }

    #[test]
    fn lockfile_from_registry_collapses() {
        let patch = "@@ -1,3 +1,3 @@\n \"node_modules/a\": {\n-  \"resolved\": \"https://registry.npmjs.org/a/-/a-1.0.0.tgz\",\n+  \"resolved\": \"https://registry.npmjs.org/a/-/a-1.0.1.tgz\",\n";
        let a = file("package-lock.json", "modified", patch);
        assert_eq!(a.hunks[0].kind, HunkKind::Lockfile);
        assert!(a.collapsible);
    }

    #[test]
    fn lockfile_from_unknown_host_is_shown() {
        let patch = "@@ -1,2 +1,2 @@\n \"node_modules/a\": {\n-  \"resolved\": \"https://registry.npmjs.org/a/-/a-1.0.0.tgz\",\n+  \"resolved\": \"https://evil.example/a-1.0.0.tgz\",\n";
        let a = file("package-lock.json", "modified", patch);
        assert!(!a.hunks[0].collapsible);
        assert!(a.hunks[0].notes[0].contains("evil.example"));
    }

    #[test]
    fn existing_generated_file_collapses() {
        let patch =
            "@@ -1,3 +1,3 @@\n // Code generated by protoc-gen-go. DO NOT EDIT.\n package pb\n-var x = 1\n+var x = 2\n";
        let a = file("pb/thing.go", "modified", patch);
        assert_eq!(a.hunks[0].kind, HunkKind::Generated);
        assert!(a.hunks[0].collapsible);
    }

    #[test]
    fn newly_added_generated_marker_is_shown() {
        let patch = "@@ -1,2 +1,3 @@\n+// @generated\n package auth\n-func Check() bool { return verify() }\n+func Check() bool { return true }\n";
        let a = file("auth/check.go", "modified", patch);
        assert_eq!(a.hunks[0].kind, HunkKind::Generated);
        assert!(!a.hunks[0].collapsible);
    }

    #[test]
    fn new_file_with_generated_name_is_shown() {
        let a = file("src/api.generated.ts", "added", "@@ -0,0 +1 @@\n+export const x = 1\n");
        assert!(!a.hunks[0].collapsible);
    }

    #[test]
    fn pure_rename_collapses() {
        let a = analyze(FileInput {
            filename: "b.rs",
            status: "renamed",
            patch: None,
        });
        assert_eq!(a.kind, Some(HunkKind::Rename));
        assert!(a.collapsible);
    }

    #[test]
    fn binary_without_patch_is_not_collapsible() {
        let a = analyze(FileInput {
            filename: "logo.png",
            status: "modified",
            patch: None,
        });
        assert!(!a.collapsible);
    }

    #[test]
    fn mixed_file_is_not_collapsible_but_import_hunk_is() {
        let patch =
            "@@ -1,2 +1,3 @@\n use std::fmt;\n+use std::io;\n \n@@ -10,2 +11,2 @@\n fn f() {\n-    a();\n+    b();\n";
        let a = file("src/lib.rs", "modified", patch);
        assert_eq!(a.hunks.len(), 2);
        assert_eq!(a.hunks[0].kind, HunkKind::ImportOnly);
        assert!(a.hunks[0].collapsible);
        assert!(!a.hunks[1].collapsible);
        assert!(!a.collapsible);
    }

    #[test]
    fn test_files_are_labelled_but_shown() {
        let a = file(
            "src/foo.test.ts",
            "modified",
            "@@ -1 +1 @@\n-expect(a).toBe(1)\n+expect(a).toBe(2)\n",
        );
        assert_eq!(a.kind, Some(HunkKind::Test));
        assert_eq!(a.hunks[0].kind, HunkKind::Test);
        assert!(!a.hunks[0].collapsible);
    }
}

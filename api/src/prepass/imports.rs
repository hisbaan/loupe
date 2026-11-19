//! Import-only hunks.
//!
//! Line-based on purpose: patches are fragments, so a parser would often see
//! partial syntax anyway. Each side of the hunk (old: context + removed, new:
//! context + added) is scanned in order so multi-line import blocks are
//! tracked. A hunk that starts inside a block it can't see the opener of is
//! treated as code.
//!
//! Imports that run code just by being there with nothing bound (JS
//! `import "./x"`, Go `import _ "x"`, Elixir `use`) aren't counted as imports.

use std::sync::LazyLock;

use regex::Regex;

use super::hunks::{Hunk, Line};

struct Block {
    opener: Regex,
    inner: Regex,
    closer: Regex,
}

struct Lang {
    single: Vec<Regex>,
    blocks: Vec<Block>,
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid import regex")
}

fn block(opener: &str, inner: &str, closer: &str) -> Block {
    Block {
        opener: re(opener),
        inner: re(inner),
        closer: re(closer),
    }
}

static RUST: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![
        re(r"^(pub(\([^)]*\))?\s+)?use\s+[\w\s:{},*]+;$"),
        re(r"^extern\s+crate\s+\w+(\s+as\s+\w+)?;$"),
        re(r"^(pub(\([^)]*\))?\s+)?mod\s+\w+;$"),
    ],
    blocks: vec![block(
        r"^(pub(\([^)]*\))?\s+)?use\s+[\w:]*\{[\w\s:{},*]*$",
        r"^[\w\s:{},*]+$",
        r"^[\w\s:{},*]*\};$",
    )],
});

static JS: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![
        re(r#"^import\s+[\w$*{}\s,]+\s+from\s*["'][^"']+["']\s*;?$"#),
        re(r#"^export\s+[\w$*{}\s,]+\s+from\s*["'][^"']+["']\s*;?$"#),
        re(r#"^import\s+[\w$]+\s*=\s*require\(\s*["'][^"']+["']\s*\)\s*;?$"#),
        re(r#"^(const|let|var)\s+[\w${}\s,:]+=\s*require\(\s*["'][^"']+["']\s*\)\s*;?$"#),
    ],
    blocks: vec![block(
        r"^(import|export)(\s+type)?(\s+[\w$]+\s*,)?\s*\{[\w$\s,]*$",
        r"^[\w$\s,]+$",
        r#"^[\w$\s,]*\}\s*(from\s*["'][^"']+["'])?\s*;?$"#,
    )],
});

static PYTHON: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![
        re(r"^import\s+[\w.]+(\s+as\s+\w+)?(\s*,\s*[\w.]+(\s+as\s+\w+)?)*$"),
        re(r"^from\s+[.\w]+\s+import\s+([\w\s,]+|\*)$"),
    ],
    blocks: vec![block(r"^from\s+[.\w]+\s+import\s*\($", r"^[\w\s,]+$", r"^[\w\s,]*\)$")],
});

static GO: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![re(r#"^import\s+([A-Za-z.][\w.]*\s+)?"[^"]+"$"#)],
    blocks: vec![block(r"^import\s*\($", r#"^([A-Za-z.][\w.]*\s+)?"[^"]+"$"#, r"^\)$")],
});

static JVM: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![
        re(r"^import\s+(static\s+)?[\w.]+(\.\*|\.\{[\w\s,]+\})?(\s+as\s+\w+)?;?$"),
        re(r"^package\s+[\w.]+;?$"),
    ],
    blocks: vec![],
});

static CSHARP: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![re(r"^(global\s+)?using\s+(static\s+)?[\w.]+(\s*=\s*[\w.<>]+)?;$")],
    blocks: vec![],
});

static C_FAMILY: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![
        re(r#"^#\s*(include|import)\s*[<"][^>"]+[>"]$"#),
        re(r"^@import\s+[\w.]+;$"),
    ],
    blocks: vec![],
});

static SWIFT: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![re(
        r"^(@testable\s+)?import\s+(class\s+|struct\s+|enum\s+|func\s+)?[\w.]+$",
    )],
    blocks: vec![],
});

static RUBY: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![re(r#"^require(_relative)?\s*\(?\s*["'][^"']+["']\s*\)?$"#)],
    blocks: vec![],
});

static PHP: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![re(r"^use\s+(function\s+|const\s+)?[\w\\{}\s,]+(\s+as\s+\w+)?;$")],
    blocks: vec![],
});

static DART: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![re(
        r#"^(import|export)\s+["'][^"']+["'](\s+(as|show|hide)\s+[\w\s,]+)*;$"#,
    )],
    blocks: vec![],
});

static HASKELL: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![re(
        r"^import\s+(qualified\s+)?[\w.]+(\s+as\s+\w+)?(\s+hiding)?(\s*\([^)]*\))?$",
    )],
    blocks: vec![],
});

static ELIXIR: LazyLock<Lang> = LazyLock::new(|| Lang {
    single: vec![re(r"^(alias|import|require)\s+[\w.{}\s,]+$")],
    blocks: vec![],
});

fn lang_for(path: &str) -> Option<&'static Lang> {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())?;
    Some(match ext.as_str() {
        "rs" => &RUST,
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" => &JS,
        "py" | "pyi" => &PYTHON,
        "go" => &GO,
        "java" | "kt" | "kts" | "scala" | "groovy" => &JVM,
        "cs" => &CSHARP,
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "m" | "mm" => &C_FAMILY,
        "swift" => &SWIFT,
        "rb" => &RUBY,
        "php" => &PHP,
        "dart" => &DART,
        "hs" => &HASKELL,
        "ex" | "exs" => &ELIXIR,
        _ => return None,
    })
}

/// For one side of the hunk, whether each line is part of an import.
fn import_flags(lang: &Lang, lines: &[&str]) -> Vec<bool> {
    let mut open: Option<&Block> = None;
    lines
        .iter()
        .map(|raw| {
            let line = raw.trim();
            if let Some(block) = open {
                if block.closer.is_match(line) {
                    open = None;
                    return true;
                }
                if line.is_empty() || block.inner.is_match(line) {
                    return true;
                }
                // Not what an import block contains: stop trusting it.
                open = None;
                return false;
            }
            if lang.single.iter().any(|r| r.is_match(line)) {
                return true;
            }
            if let Some(block) = lang.blocks.iter().find(|b| b.opener.is_match(line)) {
                open = Some(block);
                return true;
            }
            false
        })
        .collect()
}

pub fn only_imports(path: &str, hunk: &Hunk<'_>) -> bool {
    let Some(lang) = lang_for(path) else {
        return false;
    };

    // (line, is this side's change) for each side.
    let side = |keep: fn(&Line<'_>) -> Option<bool>| -> (Vec<&str>, Vec<bool>) {
        hunk.lines
            .iter()
            .filter_map(|l| keep(l).map(|changed| (l.text(), changed)))
            .unzip()
    };
    let old = side(|l| match l {
        Line::Context(_) => Some(false),
        Line::Removed(_) => Some(true),
        Line::Added(_) => None,
    });
    let new = side(|l| match l {
        Line::Context(_) => Some(false),
        Line::Added(_) => Some(true),
        Line::Removed(_) => None,
    });

    let mut any_import = false;
    for (lines, changed) in [old, new] {
        let flags = import_flags(lang, &lines);
        for ((line, changed), is_import) in lines.iter().zip(changed).zip(flags) {
            if !changed || line.trim().is_empty() {
                continue;
            }
            if !is_import {
                return false;
            }
            any_import = true;
        }
    }
    any_import
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prepass::hunks::parse_hunks;

    fn check(path: &str, patch: &str) -> bool {
        only_imports(path, &parse_hunks(patch)[0])
    }

    #[test]
    fn rust() {
        assert!(check(
            "a.rs",
            "@@ -1,2 +1,3 @@\n use std::fmt;\n+use std::{io, sync::Arc};\n+pub(crate) mod util;\n"
        ));
        assert!(check(
            "a.rs",
            "@@ -1,4 +1,5 @@\n use crate::{\n     a,\n+    b::{c, d},\n     e,\n };\n"
        ));
        assert!(!check("a.rs", "@@ -1,2 +1,3 @@\n use std::fmt;\n+static X: u8 = 1;\n"));
    }

    #[test]
    fn rust_block_without_visible_opener_is_code() {
        assert!(!check("a.rs", "@@ -3,2 +3,3 @@\n     a,\n+    b,\n };\n"));
    }

    #[test]
    fn javascript() {
        assert!(check(
            "a.ts",
            "@@ -1 +1,2 @@\n import a from \"a\"\n+import { b, type C } from \"./b\"\n"
        ));
        assert!(check(
            "a.tsx",
            "@@ -1,3 +1,4 @@\n import {\n   a,\n+  b,\n } from \"x\"\n"
        ));
        assert!(check("a.js", "@@ -1 +1,2 @@\n x\n+const { a, b } = require(\"y\");\n"));
    }

    #[test]
    fn javascript_side_effect_import_is_code() {
        assert!(!check(
            "a.ts",
            "@@ -1 +1,2 @@\n import a from \"a\"\n+import \"./polyfill\"\n"
        ));
    }

    #[test]
    fn javascript_code_in_braces_is_code() {
        assert!(!check(
            "a.ts",
            "@@ -1,3 +1,4 @@\n import {\n   a,\n+  b } from \"x\"; doEvil()\n"
        ));
    }

    #[test]
    fn python() {
        assert!(check(
            "a.py",
            "@@ -1 +1,3 @@\n import os\n+import sys as system\n+from .models import User, Group\n"
        ));
        assert!(check(
            "a.py",
            "@@ -1,3 +1,4 @@\n from x import (\n     a,\n+    b,\n )\n"
        ));
        assert!(!check("a.py", "@@ -1 +1,2 @@\n import os\n+os.system(\"x\")\n"));
    }

    #[test]
    fn go() {
        assert!(check(
            "a.go",
            "@@ -1,3 +1,4 @@\n import (\n \t\"fmt\"\n+\tlog \"github.com/x/log\"\n )\n"
        ));
        assert!(!check(
            "a.go",
            "@@ -1,3 +1,4 @@\n import (\n \t\"fmt\"\n+\t_ \"github.com/x/driver\"\n )\n"
        ));
    }

    #[test]
    fn removed_imports_count() {
        assert!(check("a.rs", "@@ -1,2 +1 @@\n use a;\n-use b;\n"));
    }

    #[test]
    fn unknown_language_is_code() {
        assert!(!check("a.zig", "@@ -1 +1,2 @@\n x\n+const std = @import(\"std\");\n"));
    }
}

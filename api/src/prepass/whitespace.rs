//! Whitespace-only changes: re-indentation, trailing whitespace, blank lines.
//! Whitespace *inside* a line is never ignored (`"rm -rf /tmp/x"` and
//! `"rm -rf / tmp/x"` are very different), and in indentation-sensitive
//! languages leading whitespace isn't either.

use super::hunks::Hunk;

fn indentation_sensitive(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    matches!(
        ext,
        "py" | "pyi" | "yaml" | "yml" | "haml" | "pug" | "jade" | "coffee" | "nim" | "fs" | "fsx" | "sass" | "slim"
    ) || name == "makefile"
        || name.ends_with(".mk")
}

pub fn only_whitespace(path: &str, hunk: &Hunk<'_>) -> bool {
    let normalize: fn(&str) -> String = if indentation_sensitive(path) {
        |line| line.trim_end().to_owned()
    } else {
        |line| line.trim().to_owned()
    };
    let collect = |lines: &mut dyn Iterator<Item = &str>| -> Vec<String> {
        lines.map(normalize).filter(|l| !l.is_empty()).collect()
    };

    let removed = collect(&mut hunk.removed());
    let added = collect(&mut hunk.added());
    let changed = hunk.lines.iter().any(|l| l.is_change());
    changed && removed == added
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prepass::hunks::parse_hunks;

    fn check(path: &str, patch: &str) -> bool {
        only_whitespace(path, &parse_hunks(patch)[0])
    }

    #[test]
    fn reindent_in_c_like_is_whitespace() {
        assert!(check(
            "a.ts",
            "@@ -1,2 +1,2 @@\n-if (a) {\n-  b()\n+if (a) {\n+    b()\n"
        ));
        assert!(check("a.rs", "@@ -1 +1,2 @@\n-x();  \n+x();\n+\n"));
    }

    #[test]
    fn reindent_in_python_is_code() {
        // Moves `b()` out of the `if` body.
        assert!(!check("a.py", "@@ -1,2 +1,2 @@\n if a:\n-    b()\n+b()\n"));
        assert!(check("a.py", "@@ -1 +1 @@\n-b()   \n+b()\n"));
    }

    #[test]
    fn real_change_is_not_whitespace() {
        assert!(!check("a.ts", "@@ -1 +1 @@\n-a + b\n+a - b\n"));
    }

    #[test]
    fn whitespace_inside_a_line_is_code() {
        assert!(!check(
            "a.ts",
            "@@ -1 +1 @@\n-run(\"rm -rf /tmp/x\")\n+run(\"rm -rf / tmp/x\")\n"
        ));
    }
}

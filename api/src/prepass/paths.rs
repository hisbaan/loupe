//! Classification from the file path alone.

use loupe_protocol::review::HunkKind;

#[derive(Debug, Default)]
pub struct PathClass {
    pub lockfile: bool,
    pub generated: bool,
    pub vendored: bool,
    pub docs: bool,
    pub test: bool,
    pub config: bool,
}

impl PathClass {
    /// The file-level label shown in the UI.
    pub fn label(&self) -> Option<HunkKind> {
        if self.lockfile {
            Some(HunkKind::Lockfile)
        } else if self.vendored {
            Some(HunkKind::Vendored)
        } else if self.generated {
            Some(HunkKind::Generated)
        } else if self.test {
            Some(HunkKind::Test)
        } else if self.docs {
            Some(HunkKind::Docs)
        } else if self.config {
            Some(HunkKind::Config)
        } else {
            None
        }
    }
}

const LOCKFILES: &[&str] = &[
    "Cargo.lock",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "deno.lock",
    "go.sum",
    "go.work.sum",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "pdm.lock",
    "Gemfile.lock",
    "composer.lock",
    "mix.lock",
    "pubspec.lock",
    "Package.resolved",
    "Podfile.lock",
    "flake.lock",
    "gradle.lockfile",
    "packages.lock.json",
];

const GENERATED_SUFFIXES: &[&str] = &[
    ".min.js",
    ".min.css",
    ".map",
    ".pb.go",
    "_pb2.py",
    "_pb2.pyi",
    "_pb2_grpc.py",
    ".pb.h",
    ".pb.cc",
    "_pb.js",
    "_pb.d.ts",
    ".g.dart",
    ".freezed.dart",
    ".snap",
];

pub fn classify(path: &str) -> PathClass {
    let lower = path.to_ascii_lowercase();
    let name = path.rsplit('/').next().unwrap_or(path);
    let lower_name = name.to_ascii_lowercase();
    let segments: Vec<&str> = lower.split('/').collect();
    let dirs = &segments[..segments.len().saturating_sub(1)];
    let in_dir = |names: &[&str]| dirs.iter().any(|d| names.contains(d));
    let ext = lower_name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");

    PathClass {
        lockfile: LOCKFILES.contains(&name),
        generated: GENERATED_SUFFIXES.iter().any(|s| lower_name.ends_with(s))
            || lower_name.contains(".generated.")
            || lower_name.contains("_generated.")
            || in_dir(&["__snapshots__", "__generated__"]),
        vendored: in_dir(&["vendor", "third_party", "third-party", "node_modules"]),
        docs: matches!(ext, "md" | "mdx" | "rst" | "adoc" | "txt")
            || in_dir(&["docs", "doc"])
            || ["license", "licence", "changelog", "authors", "notice"]
                .iter()
                .any(|n| lower_name.starts_with(n)),
        test: in_dir(&["test", "tests", "__tests__", "spec", "specs", "testdata", "e2e"])
            || lower_name.contains(".test.")
            || lower_name.contains(".spec.")
            || lower_name.ends_with("_test.go")
            || lower_name.ends_with("_test.py")
            || lower_name.ends_with("_spec.rb")
            || (lower_name.starts_with("test_") && ext == "py")
            || name.ends_with("Test.java")
            || name.ends_with("Test.kt")
            || name.ends_with("Tests.cs"),
        config: lower.starts_with(".github/")
            || lower_name.starts_with("dockerfile")
            || lower_name.starts_with(".env")
            || matches!(ext, "toml" | "yaml" | "yml" | "ini" | "cfg" | "conf")
            || (ext == "json" && dirs.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies() {
        assert!(classify("web/pnpm-lock.yaml").lockfile);
        assert!(!classify("src/lock.rs").lockfile);
        assert!(classify("dist/app.min.js").generated);
        assert!(classify("src/__snapshots__/a.tsx.snap").generated);
        assert!(classify("vendor/github.com/x/y.go").vendored);
        assert!(classify("README.md").docs);
        assert!(classify("pkg/auth_test.go").test);
        assert!(classify("tests/integration.rs").test);
        assert!(classify(".github/workflows/ci.yml").config);
        assert_eq!(classify("src/main.rs").label(), None);
    }
}

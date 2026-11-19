//! Lockfiles are collapsed, except when they pull a dependency from somewhere
//! other than the usual registries. Swapping a `resolved` URL to an attacker's
//! tarball is a known way to sneak code into a lockfile-only diff.

use std::sync::LazyLock;

use regex::Regex;

static URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:git\+)?(?:https?|ssh|git)://[^\s"',)}\]]+|\b(?:github|gitlab|bitbucket):[\w.-]+/[\w.-]+"#)
        .expect("valid regex")
});

const TRUSTED_PREFIXES: &[&str] = &[
    "https://registry.npmjs.org/",
    "https://registry.yarnpkg.com/",
    "https://registry.npmmirror.com/",
    "https://github.com/rust-lang/crates.io-index",
    "https://index.crates.io/",
    "https://static.crates.io/",
    "https://files.pythonhosted.org/",
    "https://pypi.org/",
    "https://proxy.golang.org/",
    "https://rubygems.org/",
    "https://repo.packagist.org/",
    "https://repo.hex.pm",
    "https://pub.dev",
    "https://jsr.io/",
    "https://deno.land/",
];

/// Sources on added lines that aren't a well-known registry, deduplicated.
pub fn unusual_sources<'a>(added: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for line in added {
        for m in URL.find_iter(line) {
            // Cargo.lock: `source = "registry+https://..."` / `"sparse+https://..."`.
            let url = m.as_str();
            let prefixed_registry = line[..m.start()].ends_with("registry+") || line[..m.start()].ends_with("sparse+");
            let trusted = !url.starts_with("git+")
                && !url.starts_with("http://")
                && (TRUSTED_PREFIXES.iter().any(|p| url.starts_with(p))
                    || (prefixed_registry && url.starts_with("https://")));
            if !trusted && !found.iter().any(|f| f == url) {
                found.push(url.to_owned());
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registries_are_trusted() {
        let lines = [
            r#"  "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz","#,
            r#"source = "registry+https://github.com/rust-lang/crates.io-index""#,
            r#"source = "sparse+https://index.crates.io/""#,
            r#"  resolved "https://registry.yarnpkg.com/b/-/b-2.0.0.tgz#abc""#,
        ];
        assert!(unusual_sources(lines.into_iter()).is_empty());
    }

    #[test]
    fn flags_git_and_unknown_hosts() {
        let lines = [
            r#"source = "git+https://github.com/someone/fork?rev=abc#abc""#,
            r#"  "resolved": "https://evil.example/a.tgz","#,
            r#"    resolution: {tarball: http://registry.npmjs.org/a.tgz}"#,
            r#"  "version": "github:someone/pkg#main","#,
        ];
        assert_eq!(unusual_sources(lines.into_iter()).len(), 4);
    }
}

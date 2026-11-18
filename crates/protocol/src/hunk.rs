//! Stable hunk identifiers.
//!
//! A hunk id is derived from the file path and the hunk's own text, so the same
//! hunk keeps its id across force-pushes that don't touch it, and a review can
//! be checked for complete coverage of a diff.

use sha2::{Digest, Sha256};

pub fn hunk_id(path: &str, hunk_text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update([0]);
    hasher.update(hunk_text.as_bytes());
    let digest = hasher.finalize();
    format!("h_{}", hex::encode(&digest[..10]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_and_path_sensitive() {
        let a = hunk_id("src/a.rs", "@@ -1 +1 @@\n-a\n+b\n");
        assert_eq!(a, hunk_id("src/a.rs", "@@ -1 +1 @@\n-a\n+b\n"));
        assert_ne!(a, hunk_id("src/b.rs", "@@ -1 +1 @@\n-a\n+b\n"));
        assert!(a.starts_with("h_") && a.len() == 22);
    }
}

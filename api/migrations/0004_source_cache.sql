-- Repository content fetched for review tools. Keyed by SHA, so entries never
-- go stale; they're only pruned for space. Shared between users, so only read
-- from a job whose user has already been access-checked for repo_id.

-- Recursive git tree (blobs only) of a commit, as JSON.
CREATE TABLE source_trees (
    repo_id     INTEGER NOT NULL,
    commit_sha  TEXT    NOT NULL,
    entries     TEXT    NOT NULL,
    truncated   INTEGER NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (repo_id, commit_sha)
);

CREATE TABLE source_blobs (
    repo_id     INTEGER NOT NULL,
    blob_sha    TEXT    NOT NULL,
    content     BLOB    NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (repo_id, blob_sha)
);

CREATE INDEX source_trees_created_at ON source_trees(created_at);
CREATE INDEX source_blobs_created_at ON source_blobs(created_at);

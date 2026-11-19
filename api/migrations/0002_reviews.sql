-- Guided reviews, shared between everyone who can see the pull request.
-- Reads must be access-checked against the requester's GitHub permissions.
CREATE TABLE reviews (
    id              INTEGER PRIMARY KEY,
    repo_id         INTEGER NOT NULL,
    pr_number       INTEGER NOT NULL,
    base_sha        TEXT    NOT NULL,
    head_sha        TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    prompt_version  INTEGER NOT NULL,
    schema_version  INTEGER NOT NULL,
    requested_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    review_json     TEXT    NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (repo_id, pr_number, base_sha, head_sha, model, prompt_version, schema_version)
);

CREATE INDEX reviews_lookup ON reviews(repo_id, pr_number, head_sha);

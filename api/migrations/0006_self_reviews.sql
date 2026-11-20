-- Self-reviews are private to the user who ran them: problems found in a pull
-- request (usually their own), plus their decisions and comments, exported as
-- instructions for a coding agent. notes_json is owned by the web client.
CREATE TABLE self_reviews (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_id         INTEGER NOT NULL,
    pr_number       INTEGER NOT NULL,
    base_sha        TEXT    NOT NULL,
    head_sha        TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    prompt_version  INTEGER NOT NULL,
    schema_version  INTEGER NOT NULL,
    review_json     TEXT    NOT NULL,
    notes_json      TEXT    NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX self_reviews_lookup ON self_reviews(user_id, repo_id, pr_number);

-- GitHub logins whose reviews a user trusts. auto_load shows a trusted user's
-- review without asking first.
CREATE TABLE trusted_users (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    login       TEXT    NOT NULL COLLATE NOCASE,
    auto_load   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, login)
);

-- One review per requester per cache key, so generating your own review no
-- longer replaces a teammate's. based_on is the earlier review an incremental
-- update started from (not a foreign key: it may be pruned independently).
CREATE TABLE reviews_new (
    id              INTEGER PRIMARY KEY,
    repo_id         INTEGER NOT NULL,
    pr_number       INTEGER NOT NULL,
    base_sha        TEXT    NOT NULL,
    head_sha        TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    prompt_version  INTEGER NOT NULL,
    schema_version  INTEGER NOT NULL,
    requested_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    based_on        INTEGER,
    review_json     TEXT    NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (repo_id, pr_number, base_sha, head_sha, model, prompt_version, schema_version, requested_by)
);

INSERT INTO reviews_new (id, repo_id, pr_number, base_sha, head_sha, model, prompt_version, schema_version,
                         requested_by, review_json, created_at)
SELECT id, repo_id, pr_number, base_sha, head_sha, model, prompt_version, schema_version,
       requested_by, review_json, created_at
FROM reviews;

DROP TABLE reviews;
ALTER TABLE reviews_new RENAME TO reviews;
CREATE INDEX reviews_lookup ON reviews(repo_id, pr_number, head_sha);

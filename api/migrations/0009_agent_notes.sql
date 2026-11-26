-- Self-reviews merge into reviews: everyone generates the same (shared) review,
-- and what used to be a self-review's notes becomes agent notes, private
-- comments on a pull request that the user hands to their coding agent.
--
-- Lines refer to head_sha. hunk_id is the diff hunk they were in: while that id
-- is still in the pull request's diff, the hunk is unchanged and so are its line
-- numbers. NULL for notes carried over from self-reviews, which only place on
-- their own commit.
CREATE TABLE agent_notes (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_id         INTEGER NOT NULL,
    pr_number       INTEGER NOT NULL,
    path            TEXT    NOT NULL,
    side            TEXT    NOT NULL CHECK (side IN ('new', 'old')),
    start_line      INTEGER NOT NULL,
    end_line        INTEGER NOT NULL,
    head_sha        TEXT    NOT NULL,
    hunk_id         TEXT,
    -- The lines as the diff showed them, for exports once they've changed.
    snippet         TEXT,
    body            TEXT    NOT NULL,
    -- The review finding the note was accepted from, if any.
    finding_key     TEXT,
    resolved        INTEGER NOT NULL DEFAULT 0,
    -- The head commit when the note was last handed to the agent.
    handed_off_sha  TEXT,
    handed_off_at   INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX agent_notes_lookup ON agent_notes(user_id, repo_id, pr_number);

-- What a user did with a review's finding: dismissed it, or added it to their
-- GitHub review. (Accepting one as an agent note is recorded on the note.)
-- finding_key is computed by the client from the finding's hunk, lines and
-- title, so it survives incremental updates, which renumber findings.
CREATE TABLE finding_decisions (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_id         INTEGER NOT NULL,
    pr_number       INTEGER NOT NULL,
    finding_key     TEXT    NOT NULL,
    decision        TEXT    NOT NULL CHECK (decision IN ('dismissed', 'github')),
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, repo_id, pr_number, finding_key)
);

-- Your own self-review comments, and the findings you accepted.
INSERT INTO agent_notes (user_id, repo_id, pr_number, path, side, start_line, end_line, head_sha, body, created_at)
SELECT s.user_id, s.repo_id, s.pr_number,
       json_extract(c.value, '$.path'), json_extract(c.value, '$.side'),
       json_extract(c.value, '$.start_line'), json_extract(c.value, '$.end_line'),
       s.head_sha, json_extract(c.value, '$.body'), s.updated_at
FROM self_reviews s, json_each(s.notes_json, '$.comments') c
WHERE json_extract(c.value, '$.side') IN ('new', 'old')
  AND json_extract(c.value, '$.path') IS NOT NULL
  AND json_extract(c.value, '$.body') IS NOT NULL;

INSERT INTO agent_notes (user_id, repo_id, pr_number, path, side, start_line, end_line, head_sha, body, created_at)
SELECT s.user_id, s.repo_id, s.pr_number,
       json_extract(f.value, '$.path'), json_extract(f.value, '$.side'),
       json_extract(f.value, '$.start_line'), json_extract(f.value, '$.end_line'),
       s.head_sha,
       json_extract(f.value, '$.title') || char(10) || char(10) ||
           coalesce(json_extract(d.value, '$.body'), json_extract(f.value, '$.body')),
       s.updated_at
FROM self_reviews s, json_each(s.review_json, '$.findings') f, json_each(s.notes_json, '$.findings') d
WHERE d.key = json_extract(f.value, '$.id')
  AND json_extract(d.value, '$.status') = 'accepted'
  AND json_extract(f.value, '$.side') IN ('new', 'old');

DROP TABLE self_reviews;

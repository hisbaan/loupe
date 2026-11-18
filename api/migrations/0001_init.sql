CREATE TABLE users (
    id          INTEGER PRIMARY KEY,
    github_id   INTEGER NOT NULL UNIQUE,
    login       TEXT    NOT NULL,
    avatar_url  TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- GitHub user-to-server tokens, encrypted at rest with LOUPE_SECRET_KEY.
CREATE TABLE github_tokens (
    user_id                  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token_enc         BLOB    NOT NULL,
    access_expires_at        INTEGER,
    refresh_token_enc        BLOB,
    refresh_expires_at       INTEGER,
    updated_at               INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Only the SHA-256 of the session token is stored.
CREATE TABLE sessions (
    token_hash  BLOB    PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX sessions_user_id ON sessions(user_id);

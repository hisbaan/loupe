-- Preferences that follow a user between computers: model, effort and how
-- diffs look. Nothing secret. settings_json is owned by the web client, which
-- validates every field it reads.
CREATE TABLE user_settings (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings_json  TEXT    NOT NULL,
    updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

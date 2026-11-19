-- Inference credential vault. The browser encrypts the vault with a random
-- vault key (VK); the server can decrypt neither the vault nor the VK.
CREATE TABLE vaults (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- Bumped on every write; writes are compare-and-swap on this because
    -- ChatGPT refresh tokens rotate and two tabs or devices may race.
    version     INTEGER NOT NULL,
    ciphertext  BLOB    NOT NULL,
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Copies of the VK, each wrapped by a key only the user can derive: a passkey's
-- WebAuthn PRF output, or a passphrase (PBKDF2) for browsers without PRF.
CREATE TABLE vault_keys (
    id             INTEGER PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES vaults(user_id) ON DELETE CASCADE,
    kind           TEXT    NOT NULL CHECK (kind IN ('passkey', 'passphrase')),
    label          TEXT    NOT NULL,
    credential_id  BLOB,
    salt           BLOB    NOT NULL,
    iterations     INTEGER,
    wrapped_key    BLOB    NOT NULL,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK ((kind = 'passkey') = (credential_id IS NOT NULL)),
    CHECK ((kind = 'passphrase') = (iterations IS NOT NULL))
);

CREATE INDEX vault_keys_user_id ON vault_keys(user_id);

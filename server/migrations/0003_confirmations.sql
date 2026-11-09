-- Fresh email confirmation before the actions a stolen session must not take on its own:
-- deleting the account and adding a passkey. One row per request; the code is stored hashed.
CREATE TABLE confirmations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  action TEXT NOT NULL,                    -- delete_account | add_passkey
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX confirmations_expiry ON confirmations(expires_at);

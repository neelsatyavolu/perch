-- Perch account, sync and relay schema. The server stores ciphertext, sizes, timestamps and ids.
-- Tokens and codes are stored as SHA-256 hashes, never as values.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,          -- last change sequence number handed out
  purge_seq INTEGER NOT NULL DEFAULT 0,    -- tombstones at or below this seq have been purged
  bytes_used INTEGER NOT NULL DEFAULT 0,
  key_version INTEGER NOT NULL DEFAULT 0,  -- 0 until the first device creates a sync key
  key_rotation TEXT                        -- nonce of the last rotation, guards concurrent rotations
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX devices_account ON devices(account_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_device ON sessions(device_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE email_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  link_hash TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  poll_hash TEXT NOT NULL,
  match_number INTEGER NOT NULL,
  device_name TEXT NOT NULL,
  device_kind TEXT NOT NULL,
  device_public_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                    -- pending | approved | done | failed
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX email_requests_expiry ON email_requests(expires_at);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,                     -- credential id, base64url
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,                -- COSE public key, base64url
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_account ON passkeys(account_id);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  kind TEXT NOT NULL,                      -- register | login
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX challenges_expiry ON challenges(expires_at);

CREATE TABLE wrapped_keys (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,                      -- a device id, or "recovery"
  version INTEGER NOT NULL,
  blob TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, slot)
);

CREATE TABLE items (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,                        -- HMAC of the real id, made by the client
  version INTEGER NOT NULL,
  key_version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  size INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  data TEXT,                               -- small ciphertext, base64url
  blob_key TEXT,                           -- R2 key for large ciphertext
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, collection, id)
);
CREATE INDEX items_changes ON items(account_id, collection, seq);
CREATE INDEX items_tombstones ON items(deleted, updated_at);

CREATE TABLE pairings (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,               -- first 40 bits of SHA-256 of the public key
  public_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  poll_hash TEXT NOT NULL,
  status TEXT NOT NULL,                    -- pending | approved | done | denied
  account_id TEXT,
  device_id TEXT,
  approver_device_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX pairings_expiry ON pairings(expires_at);

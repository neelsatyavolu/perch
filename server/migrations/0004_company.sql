-- Company mode (AUTH_MODE=company): sign-in through the company's OpenID Connect provider, and
-- admin sessions for listing and revoking devices. The account key is the provider's (issuer,
-- subject) pair; the email on the account is for display only.
CREATE TABLE identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX identities_account ON identities(account_id);

-- One row per sign-in started by a device. The poll secret, state and browser binding are stored
-- as SHA-256 hashes. The nonce and PKCE verifier live only until the callback uses them.
CREATE TABLE oidc_requests (
  id TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL,
  state_hash TEXT UNIQUE,                  -- set when the right number is typed
  binding_hash TEXT,                       -- the cookie that ties the callback to that browser
  nonce TEXT,
  verifier TEXT,
  match_number INTEGER NOT NULL,
  device_name TEXT NOT NULL,
  device_kind TEXT NOT NULL,
  device_public_key TEXT NOT NULL,
  status TEXT NOT NULL,                    -- pending | authorizing | verifying | approved | done | failed
  account_id TEXT,
  admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oidc_requests_expiry ON oidc_requests(expires_at);

-- 1 only for a session made by company sign-in whose verified ID token had OIDC_ADMIN_GROUP.
ALTER TABLE sessions ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;

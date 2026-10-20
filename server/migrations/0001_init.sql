-- cert-garden backend 初回schema。メールは保存しない（本人IDは provider+sub のみ）。
-- クラウド保存(backups)は端末データのバックアップで、課金/購入の権利の正本ではない（権利用テーブルは作らない）。

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
) STRICT;

-- 同じメールでも別 sub は別人。結合キーは (provider, sub) のみ。
CREATE TABLE identities (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  sub TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, sub)
) STRICT;
CREATE INDEX identities_user ON identities(user_id);

-- ログイン/再認証用 challenge。nonce は SHA-256 hex のみ保存し、1回消費(consumed_at)。
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'reauth')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  nonce_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
) STRICT;
CREATE INDEX auth_challenges_expires ON auth_challenges(expires_at);

-- 1ログイン = 1 family。refresh は回転し、再利用検知で family 全体を失効する。
CREATE TABLE session_families (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT
) STRICT;
CREATE INDEX session_families_user ON session_families(user_id);

CREATE TABLE access_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES session_families(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX access_tokens_family ON access_tokens(family_id);

CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES session_families(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;
CREATE INDEX refresh_tokens_family ON refresh_tokens(family_id);

-- Apple refresh token は AES-GCM 暗号文のみ。鍵は Worker secret。
CREATE TABLE apple_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enc_refresh_token TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- クラウド保存（本人専用の端末データバックアップ）。revision による CAS。
CREATE TABLE backups (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  payload TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  last_request_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- D1に置く固定窓レート制限（instanceメモリに依存しない）。
CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
) STRICT;

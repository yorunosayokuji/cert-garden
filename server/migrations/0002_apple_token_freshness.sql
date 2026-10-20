-- Appleのrefresh tokenを日次で照合するための鮮度と、更新のCAS用バージョン。
-- 既存行(0001のみ適用済みのローカルDB)は last_checked_at=0 = 「次のrefreshで必ず照合」になる。
ALTER TABLE apple_credentials ADD COLUMN last_checked_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apple_credentials ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

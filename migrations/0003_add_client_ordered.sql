-- 元請け受注済フラグを追加
-- 既存データはユーザー要望により全件「受注済」とする
ALTER TABLE estimates ADD COLUMN client_ordered INTEGER NOT NULL DEFAULT 0;

UPDATE estimates
SET client_ordered = 1;

CREATE INDEX IF NOT EXISTS idx_estimates_client_ordered
ON estimates(client_ordered);

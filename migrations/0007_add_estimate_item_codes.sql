-- 見積明細の比較項目をユーザー追加可能にする
CREATE TABLE IF NOT EXISTS estimate_item_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_estimate_item_codes_label
ON estimate_item_codes(label);

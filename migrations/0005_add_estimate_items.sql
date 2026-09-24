-- 見積明細
-- 1つの見積に複数の明細行を保存する
CREATE TABLE IF NOT EXISTS estimate_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL,
  category TEXT,
  description TEXT,
  specification TEXT,
  quantity REAL,
  unit TEXT,
  unit_price REAL,
  amount REAL,
  remarks TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_estimate_items_estimate_id_sort
ON estimate_items(estimate_id, sort_order, id);

CREATE INDEX IF NOT EXISTS idx_estimate_items_category
ON estimate_items(category);

-- 類似案件比較用の建物規模情報
ALTER TABLE estimates ADD COLUMN above_ground_floors INTEGER;
ALTER TABLE estimates ADD COLUMN basement_floors INTEGER;
ALTER TABLE estimates ADD COLUMN total_floor_area REAL;

-- 見積明細を案件間で比較するための統一コード
ALTER TABLE estimate_items ADD COLUMN item_code TEXT;

CREATE INDEX IF NOT EXISTS idx_estimates_similarity
ON estimates(structure, building_use, above_ground_floors, rebar_quantity, total_floor_area);

CREATE INDEX IF NOT EXISTS idx_estimate_items_item_code
ON estimate_items(item_code);

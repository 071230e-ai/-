-- NET金額を追加
-- 既存データはユーザー指定により、現在の見積金額をすべてNET金額として引き継ぐ
ALTER TABLE estimates ADD COLUMN net_amount REAL;

UPDATE estimates
SET net_amount = estimate_amount;

-- 単価はNET金額を基準に再計算する
UPDATE estimates
SET unit_price = CASE
  WHEN rebar_quantity IS NOT NULL AND rebar_quantity > 0 AND net_amount IS NOT NULL
    THEN net_amount / rebar_quantity / 1000.0
  ELSE unit_price
END;

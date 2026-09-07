-- 見積番号の重複を解消して UNIQUE 制約を追加
-- 既存データに重複がある場合は、2件目以降だけ末尾に -DUP-<id> を付与する。

UPDATE estimates
SET estimate_no = CASE
  WHEN TRIM(COALESCE(estimate_no, '')) = '' THEN 'LEGACY-' || id
  ELSE estimate_no || '-DUP-' || id
END
WHERE id IN (
  SELECT e.id
  FROM estimates e
  JOIN (
    SELECT estimate_no
    FROM estimates
    GROUP BY estimate_no
    HAVING COUNT(*) > 1
  ) d ON e.estimate_no = d.estimate_no
  WHERE e.id NOT IN (
    SELECT MIN(id)
    FROM estimates
    GROUP BY estimate_no
  )
);

-- 空文字の見積番号が1件だけ存在する場合も補正する。
UPDATE estimates
SET estimate_no = 'LEGACY-' || id
WHERE TRIM(COALESCE(estimate_no, '')) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_estimates_estimate_no_unique
ON estimates(estimate_no);

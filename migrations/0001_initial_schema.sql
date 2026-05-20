-- 村田鉄筋株式会社 見積データベース 初期スキーマ

-- ユーザーテーブル (認証用)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', -- 'admin' or 'user'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 見積データテーブル
CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_no TEXT NOT NULL,                 -- 見積番号
  estimate_date TEXT NOT NULL,               -- 見積日 (YYYY-MM-DD)
  client_name TEXT NOT NULL,                 -- 元請け会社名
  site_name TEXT NOT NULL,                   -- 現場名
  site_location TEXT,                        -- 工事場所
  structure TEXT,                            -- 建物の構造
  building_use TEXT,                         -- 建物用途
  rebar_quantity REAL,                       -- 鉄筋数量 (t)
  estimate_amount REAL,                      -- 見積金額 (円)
  unit_price REAL,                           -- 単価 (円/kg)
  material_type TEXT,                        -- 材料区分 (材工/手間請け/支給材)
  estimator TEXT,                            -- 見積担当者
  result TEXT NOT NULL DEFAULT '未定',        -- 結果 (受注/失注/未定)
  lost_reason TEXT,                          -- 失注理由
  order_date TEXT,                           -- 受注日
  remarks TEXT,                              -- 備考

  -- 追加項目
  competitor TEXT,                           -- 競合会社名
  expected_actual_unit_price REAL,           -- 予想実行単価
  profit_estimate REAL,                      -- 利益見込み (円)
  construction_period TEXT,                  -- 工期
  construction_start_date TEXT,              -- 着工予定日
  processing_start_date TEXT,                -- 加工開始予定日
  difficulty TEXT,                           -- 難易度 (低/中/高)
  site_manager TEXT,                         -- 現場担当予定者
  re_estimate INTEGER DEFAULT 0,             -- 再見積の有無 (0/1)
  client_contact_name TEXT,                  -- 元請け担当者名
  client_contact_info TEXT,                  -- 元請け担当者の連絡先

  created_by INTEGER,                        -- 登録者ユーザーID
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_estimates_date ON estimates(estimate_date);
CREATE INDEX IF NOT EXISTS idx_estimates_client ON estimates(client_name);
CREATE INDEX IF NOT EXISTS idx_estimates_structure ON estimates(structure);
CREATE INDEX IF NOT EXISTS idx_estimates_result ON estimates(result);
CREATE INDEX IF NOT EXISTS idx_estimates_estimator ON estimates(estimator);
CREATE INDEX IF NOT EXISTS idx_estimates_material ON estimates(material_type);
CREATE INDEX IF NOT EXISTS idx_estimates_use ON estimates(building_use);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

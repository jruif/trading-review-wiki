-- Trading Review Wiki — 本地 cn_stock_db 初始化
-- 用途：
--   cn_stock_name_wind        App Settings「PostgreSQL 股票代码源」
--   cn_stock_price_daily_wind CLI stock_daily_sql 日线检索
--
-- 默认连接（Settings / PG_SHIHAO_*）：
--   host=127.0.0.1  port=5432  database=cn_stock_db
--   user=cn_stock   password=cn_stock
--   use_tls=关闭（本机 localhost）

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. 角色与数据库（在 postgres 库执行）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cn_stock') THEN
    CREATE ROLE cn_stock LOGIN PASSWORD 'cn_stock';
  ELSE
    ALTER ROLE cn_stock WITH LOGIN PASSWORD 'cn_stock';
  END IF;
END
$$;

SELECT format('CREATE DATABASE %I OWNER cn_stock', 'cn_stock_db')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cn_stock_db')
\gexec

GRANT ALL PRIVILEGES ON DATABASE cn_stock_db TO cn_stock;

-- ---------------------------------------------------------------------------
-- 2. 表结构 + 示例数据（在 cn_stock_db 执行）
-- ---------------------------------------------------------------------------
\connect cn_stock_db

CREATE TABLE IF NOT EXISTS public.cn_stock_name_wind (
  ticker     text        NOT NULL,
  stock_name text        NOT NULL,
  date       date        NOT NULL,
  PRIMARY KEY (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_cn_stock_name_wind_name
  ON public.cn_stock_name_wind (stock_name);

CREATE TABLE IF NOT EXISTS public.cn_stock_price_daily_wind (
  ticker   text        NOT NULL,
  date     date        NOT NULL,
  open     numeric,
  high     numeric,
  low      numeric,
  close    numeric,
  pct_cng  numeric,
  volume   bigint,
  amount   numeric,
  turnover numeric,
  PRIMARY KEY (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_cn_stock_price_daily_wind_ticker_date
  ON public.cn_stock_price_daily_wind (ticker, date DESC);

GRANT USAGE ON SCHEMA public TO cn_stock;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cn_stock;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cn_stock;

-- 股票名称（含 CHANGELOG 中提到的爱迪特真值 SZ301580）
INSERT INTO public.cn_stock_name_wind (ticker, stock_name, date) VALUES
  ('SH603629', '利通电子', '2026-06-13'),
  ('SZ000001', '平安银行', '2026-06-13'),
  ('SZ301580', '爱迪特',   '2026-06-13'),
  ('SZ000636', '风华高科', '2026-06-13'),
  ('SH600519', '贵州茅台', '2026-06-13'),
  ('SZ300750', '宁德时代', '2026-06-13')
ON CONFLICT (ticker, date) DO UPDATE
  SET stock_name = EXCLUDED.stock_name;

-- 利通电子 SH603629 — 近 10 个交易日示例（供 stock_daily_sql / Market Validation 测试）
INSERT INTO public.cn_stock_price_daily_wind
  (ticker, date, open, high, low, close, pct_cng, volume, amount, turnover)
VALUES
  ('SH603629', '2026-06-02', 18.20, 18.80, 18.00, 18.50,  1.65, 125000, 231250000, 2.10),
  ('SH603629', '2026-06-03', 18.55, 19.10, 18.40, 18.95,  2.43, 142000, 269090000, 2.38),
  ('SH603629', '2026-06-04', 18.90, 19.50, 18.80, 19.30,  1.85, 158000, 304940000, 2.65),
  ('SH603629', '2026-06-05', 19.25, 20.10, 19.10, 19.85,  2.85, 176000, 349360000, 2.95),
  ('SH603629', '2026-06-06', 19.80, 20.50, 19.60, 20.20,  1.76, 165000, 333300000, 2.77),
  ('SH603629', '2026-06-09', 20.10, 20.80, 19.90, 20.55,  1.73, 188000, 386340000, 3.15),
  ('SH603629', '2026-06-10', 20.50, 21.20, 20.30, 20.90,  1.70, 201000, 420090000, 3.37),
  ('SH603629', '2026-06-11', 20.85, 21.50, 20.60, 21.10,  0.96, 195000, 411450000, 3.27),
  ('SH603629', '2026-06-12', 21.00, 21.80, 20.90, 21.60,  2.37, 220000, 475200000, 3.69),
  ('SH603629', '2026-06-13', 21.55, 22.30, 21.40, 22.10,  2.31, 245000, 541450000, 4.11)
ON CONFLICT (ticker, date) DO UPDATE SET
  open = EXCLUDED.open,
  high = EXCLUDED.high,
  low = EXCLUDED.low,
  close = EXCLUDED.close,
  pct_cng = EXCLUDED.pct_cng,
  volume = EXCLUDED.volume,
  amount = EXCLUDED.amount,
  turnover = EXCLUDED.turnover;

-- 风华高科 SZ000636 — 测试用第二只股票
INSERT INTO public.cn_stock_price_daily_wind
  (ticker, date, open, high, low, close, pct_cng, volume, amount, turnover)
VALUES
  ('SZ000636', '2026-06-11', 14.50, 14.90, 14.40, 14.70,  1.38,  98000, 144060000, 1.05),
  ('SZ000636', '2026-06-12', 14.75, 15.40, 14.70, 15.20,  3.40, 120000, 182400000, 1.28),
  ('SZ000636', '2026-06-13', 15.10, 15.80, 15.00, 15.60,  2.63, 135000, 210600000, 1.44)
ON CONFLICT (ticker, date) DO UPDATE SET
  open = EXCLUDED.open,
  high = EXCLUDED.high,
  low = EXCLUDED.low,
  close = EXCLUDED.close,
  pct_cng = EXCLUDED.pct_cng,
  volume = EXCLUDED.volume,
  amount = EXCLUDED.amount,
  turnover = EXCLUDED.turnover;

-- 平安银行 SZ000001 — 少量数据
INSERT INTO public.cn_stock_price_daily_wind
  (ticker, date, open, high, low, close, pct_cng, volume, amount, turnover)
VALUES
  ('SZ000001', '2026-06-12', 11.20, 11.35, 11.15, 11.30,  0.89, 520000, 587600000, 0.27),
  ('SZ000001', '2026-06-13', 11.28, 11.42, 11.25, 11.38,  0.71, 498000, 566724000, 0.26)
ON CONFLICT (ticker, date) DO UPDATE SET
  open = EXCLUDED.open,
  high = EXCLUDED.high,
  low = EXCLUDED.low,
  close = EXCLUDED.close,
  pct_cng = EXCLUDED.pct_cng,
  volume = EXCLUDED.volume,
  amount = EXCLUDED.amount,
  turnover = EXCLUDED.turnover;

\echo '--- cn_stock_db 初始化完成 ---'
SELECT 'cn_stock_name_wind' AS table_name, count(*) AS rows FROM public.cn_stock_name_wind
UNION ALL
SELECT 'cn_stock_price_daily_wind', count(*) FROM public.cn_stock_price_daily_wind;

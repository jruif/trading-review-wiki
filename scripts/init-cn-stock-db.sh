#!/usr/bin/env bash
# 初始化本地 PostgreSQL cn_stock_db（需已安装 postgresql@15 且服务在运行）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQL_FILE="$ROOT/scripts/sql/init-cn-stock-db.sql"

if ! command -v psql >/dev/null 2>&1; then
  echo "错误: 未找到 psql，请先安装 PostgreSQL 15" >&2
  exit 1
fi

if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  echo "PostgreSQL 未运行，尝试启动 postgresql@15 …"
  if command -v brew >/dev/null 2>&1; then
    brew services start postgresql@15
    sleep 2
  fi
fi

if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  echo "错误: 127.0.0.1:5432 仍无法连接，请手动启动 PostgreSQL" >&2
  exit 1
fi

echo "执行 $SQL_FILE"
psql -v ON_ERROR_STOP=1 -d postgres -f "$SQL_FILE"

echo ""
echo "Settings 推荐配置："
echo "  Host: 127.0.0.1   Port: 5432   Database: cn_stock_db"
echo "  User: cn_stock    Password: cn_stock   TLS: 关闭"
echo ""
echo "CLI 环境变量示例："
echo "  export PG_SHIHAO_HOST=127.0.0.1 PG_SHIHAO_PORT=5432"
echo "  export PG_SHIHAO_USER=cn_stock PG_SHIHAO_PASSWORD=cn_stock"
echo "  export PG_SHIHAO_DATABASE=cn_stock_db"

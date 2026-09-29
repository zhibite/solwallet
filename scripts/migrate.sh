#!/bin/bash
#
# SolWallet 数据库迁移脚本（如果以后用 migration 工具）
# 用法：bash scripts/migrate.sh
#

set -euo pipefail

APP_DIR="/opt/solwallet"
cd "$APP_DIR"

# 简单迁移：执行 SQL 文件
MIGRATIONS_DIR="$APP_DIR/migrations"
if [ -d "$MIGRATIONS_DIR" ]; then
    echo "[运行迁移]"
    for sql in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
        echo "  → $(basename $sql)"
        PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "${POSTGRES_USER:-solwallet}" -d "${APP_NAME:-solwallet}" -f "$sql"
    done
else
    echo "[无需迁移]"
fi

#!/bin/bash
#
# SolWallet 数据库恢复脚本
# 用法：bash scripts/restore.sh <backup-dir-name>
#

set -euo pipefail

APP_NAME="solwallet"
APP_DIR="/opt/solwallet"
BACKUP_DIR="/opt/backups/$APP_NAME"
BACKUP_NAME="${1:-}"

if [ -z "$BACKUP_NAME" ]; then
    echo "请指定备份目录名："
    ls -1 "$BACKUP_DIR" | head -10
    echo ""
    read -p "输入目录名: " BACKUP_NAME
fi

BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"

if [ ! -d "$BACKUP_PATH" ]; then
    echo "备份不存在: $BACKUP_PATH"
    exit 1
fi

echo "================================================"
echo "  恢复 $BACKUP_NAME"
echo "================================================"

# 1. 停止应用
echo "[1/4] 停止应用"
pm2 stop $APP_NAME || true

# 2. 恢复数据库
echo "[2/4] 恢复数据库"
if [ -f "$BACKUP_PATH/db.sql.gz" ]; then
    DB_USER="${POSTGRES_USER:-solwallet}"
    PGPASSWORD="$POSTGRES_PASSWORD" dropdb -h 127.0.0.1 -U "$DB_USER" --if-exists "$APP_NAME"
    PGPASSWORD="$POSTGRES_PASSWORD" createdb -h 127.0.0.1 -U "$DB_USER" "$APP_NAME"
    gunzip -c "$BACKUP_PATH/db.sql.gz" | PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$DB_USER" -d "$APP_NAME"
else
    echo "  ⚠️  数据库备份不存在"
fi

# 3. 恢复 .env
echo "[3/4] 恢复 .env"
if [ -f "$BACKUP_PATH/env.encrypted" ]; then
    openssl enc -aes-256-cbc -d -pbkdf2 \
        -in "$BACKUP_PATH/env.encrypted" \
        -out "$APP_DIR/.env" \
        -pass pass:"${BACKUP_PASS:-solwallet-backup}"
fi

# 4. 重启应用
echo "[4/4] 重启应用"
cd "$APP_DIR"
pm2 start $APP_NAME || pm2 restart $APP_NAME

echo ""
echo "恢复完成！"

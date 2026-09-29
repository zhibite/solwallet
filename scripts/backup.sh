#!/bin/bash
#
# SolWallet 备份脚本（每日执行，crontab: 0 3 * * * bash /opt/solwallet/scripts/backup.sh）
# 备份内容：
#   - PostgreSQL 数据库
#   - Redis 数据（dump.rdb）
#   - .env 文件（加密）
# 备份保留 7 天
#

set -euo pipefail

APP_NAME="solwallet"
APP_DIR="/opt/solwallet"
BACKUP_DIR="/opt/backups/$APP_NAME"
DATE=$(date '+%Y%m%d-%H%M%S')
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR/$DATE"

echo "================================================"
echo "  $APP_NAME 备份 $DATE"
echo "================================================"

# 1. 备份 PostgreSQL
echo "[1/3] 备份数据库"
DB_DUMP="$BACKUP_DIR/$DATE/db.sql.gz"
PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump \
    -h 127.0.0.1 -U "${POSTGRES_USER:-solwallet}" \
    -d "${APP_NAME}" | gzip > "$DB_DUMP"
echo "  → $(ls -lh "$DB_DUMP" | awk '{print $5}')"

# 2. 备份 Redis
echo "[2/3] 备份 Redis"
REDIS_PASS=$(grep "^requirepass" /etc/redis/redis.conf | cut -d' ' -f2)
redis-cli -a "$REDIS_PASS" BGSAVE
sleep 3
cp /var/lib/redis/dump.rdb "$BACKUP_DIR/$DATE/redis-dump.rdb" 2>/dev/null || echo "  redis 备份失败（可忽略，重启时会自动加载）"

# 3. 备份 .env（加密）
echo "[3/3] 备份 .env"
ENV_FILE="$BACKUP_DIR/$DATE/env.encrypted"
openssl enc -aes-256-cbc -salt -pbkdf2 \
    -in "$APP_DIR/.env" \
    -out "$ENV_FILE" \
    -pass pass:"${BACKUP_PASS:-solwallet-backup}"
echo "  → $ENV_FILE"

# 清理旧备份
echo "[清理] 删除 $KEEP_DAYS 天前的备份"
find "$BACKUP_DIR" -maxdepth 1 -type d -mtime +$KEEP_DAYS -exec rm -rf {} \; 2>/dev/null || true

echo ""
echo "备份完成: $BACKUP_DIR/$DATE/"
echo ""
echo "恢复方法："
echo "  bash scripts/restore.sh $DATE"

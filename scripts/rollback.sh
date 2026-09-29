#!/bin/bash
#
# SolWallet 回滚脚本（更新出错时使用）
# 用法：
#   bash scripts/rollback.sh
#   bash scripts/rollback.sh <commit-hash>
#

set -euo pipefail

APP_NAME="solwallet"
APP_DIR="/opt/solwallet"
BRANCH="${BRANCH:-main}"
TARGET="${1:-HEAD~1}"  # 默认回滚到上一个 commit

cd "$APP_DIR"

echo "================================================"
echo "  $APP_NAME 回滚到 $TARGET"
echo "================================================"

# 显示最近 10 个 commit 供选择
echo "[最近的 commit]"
git log --oneline -10
echo ""

if [ -z "$1" ]; then
    read -p "  回滚到 [HEAD~1]: " TARGET
    TARGET="${TARGET:-HEAD~1}"
fi

# 备份当前版本
echo "[备份当前版本]"
git tag "rollback-backup-$(date '+%Y%m%d-%H%M%S')" || true

# 硬重置
echo "[重置到 $TARGET]"
git reset --hard "$TARGET"

# 重新构建
echo "[重新构建]"
npm ci --omit=dev
npm run build

# 重启
echo "[重启应用]"
pm2 reload $APP_NAME 2>/dev/null || pm2 restart $APP_NAME

echo ""
echo "================================================"
echo "  回滚完成"
echo "  当前: $(git rev-parse --short HEAD) - $(git log -1 --pretty=%B | head -1)"
echo "================================================"

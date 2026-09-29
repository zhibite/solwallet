#!/bin/bash
#
# SolWallet 状态检查脚本（部署后用）
# 用法：
#   bash scripts/status.sh
#

set -e

APP_NAME="solwallet"
APP_DIR="/opt/solwallet"

echo "================================================"
echo "  $APP_NAME 状态检查"
echo "================================================"

echo ""
echo "[1] PM2 状态"
pm2 status $APP_NAME 2>/dev/null || echo "  ⚠️  PM2 中未找到 $APP_NAME"

echo ""
echo "[2] 端口监听"
ss -tlnp 2>/dev/null | grep -E ':(3000|80|443|5432|6379)' || netstat -tlnp 2>/dev/null | grep -E ':(3000|80|443|5432|6379)'

echo ""
echo "[3] 磁盘使用"
df -h "$APP_DIR" | tail -1

echo ""
echo "[4] 内存使用"
free -h | grep -E "Mem|Swap"

echo ""
echo "[5] 应用健康"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:3000/api/rpc/status || echo "FAILED")
echo "  /api/rpc/status → HTTP $HTTP_CODE"
if [ "$HTTP_CODE" = "200" ]; then
    echo ""
    echo "[6] RPC 端点状态"
    curl -s http://127.0.0.1:3000/api/rpc/status | python3 -m json.tool 2>/dev/null | head -40
fi

echo ""
echo "[7] 最近 10 行应用日志"
pm2 logs $APP_NAME --lines 10 --nostream 2>/dev/null || tail -10 "$APP_DIR/logs/out.log"

echo ""
echo "[8] Git 状态"
cd "$APP_DIR"
git log --oneline -5
echo "  当前: $(git rev-parse --short HEAD) / 远程: $(git rev-parse --short origin/$BRANCH 2>/dev/null || echo 'N/A')"

#!/bin/bash
#
# SolWallet 更新脚本
# 流程：本地修改 → git push 到 GitHub → 服务器执行此脚本
# 用法：
#   bash scripts/update.sh
#   bash scripts/update.sh --skip-build    # 仅拉取不构建（紧急回滚代码）
#

set -euo pipefail

APP_NAME="solwallet"
APP_DIR="/opt/solwallet"
BRANCH="${BRANCH:-main}"
SKIP_BUILD=false
HARD_RESET=false
CUSTOM_MESSAGE=""

# 参数解析
while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-build) SKIP_BUILD=true; shift ;;
        --hard-reset) HARD_RESET=true; shift ;;
        --message) CUSTOM_MESSAGE="$2"; shift 2 ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

cd "$APP_DIR"

echo "================================================"
echo "  $APP_NAME 更新脚本"
echo "  分支: $BRANCH"
echo "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "================================================"

# 1. 备份当前版本（出问题时可快速回滚）
echo "[1/7] 备份当前版本"
if [ -d ".next" ]; then
    rm -rf .next.bak
    cp -r .next .next.bak
    echo "  备份到 .next.bak"
fi

# 2. 检查 git 状态
echo "[2/7] 检查 git 状态"
if [ -n "$(git status --porcelain)" ]; then
    echo "  ⚠️  检测到未提交的本地修改："
    git status --short
    read -p "  是否暂存并丢弃? [y/N] " yn
    if [[ "$yn" =~ ^[Yy]$ ]]; then
        git stash push -u -m "auto-stash-before-update $(date '+%Y-%m-%d %H:%M:%S')"
    else
        echo "  取消更新"
        exit 1
    fi
fi

# 3. 拉取最新代码
echo "[3/7] 拉取最新代码"
if [ "$HARD_RESET" = true ]; then
    echo "  硬重置到 origin/$BRANCH（丢弃所有本地 commit）"
    git fetch origin
    git reset --hard "origin/$BRANCH"
else
    git pull origin "$BRANCH"
fi

LATEST_COMMIT=$(git rev-parse --short HEAD)
LATEST_MSG=$(git log -1 --pretty=%B | head -1)
echo "  最新 commit: $LATEST_COMMIT - $LATEST_MSG"
[[ -n "$CUSTOM_MESSAGE" ]] && echo "  备注: $CUSTOM_MESSAGE"

# 4. 安装新依赖（如果有 package.json 变更）
echo "[4/7] 检查依赖变更"
if git diff HEAD@{1} HEAD --name-only 2>/dev/null | grep -q "^package.*\.json"; then
    echo "  package.json 有变更，重新安装依赖"
    npm ci --omit=dev
else
    echo "  依赖无变化，跳过安装"
fi

# 5. 重新构建
if [ "$SKIP_BUILD" = true ]; then
    echo "[5/7] 跳过构建（--skip-build）"
else
    echo "[5/7] 重新构建"
    npm run build
fi

# 6. 数据库迁移
echo "[6/7] 数据库迁移（如果需要）"
# 如果有迁移脚本：node scripts/migrate.js

# 7. 重启应用（零停机）
echo "[7/7] 重启应用"
pm2 reload $APP_NAME 2>/dev/null || pm2 restart $APP_NAME

# 健康检查
echo ""
echo "[健康检查]"
sleep 3
for i in 1 2 3 4 5; do
    if curl -fsS http://127.0.0.1:3000/api/rpc/status -m 5 > /dev/null; then
        echo "  ✅ 应用响应正常"
        break
    fi
    echo "  等待应用启动... ($i/5)"
    sleep 2
done

# 清理备份
rm -rf .next.bak

echo ""
echo "================================================"
echo "  更新完成！"
echo ""
echo "  当前版本: $LATEST_COMMIT - $LATEST_MSG"
echo "  查看日志: pm2 logs $APP_NAME --lines 50"
echo "  回滚到上一版本: bash scripts/rollback.sh"
echo "================================================"

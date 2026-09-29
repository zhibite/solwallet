#!/bin/bash
# SolWallet 一次性脚本：初始化 git 仓库并推送到 GitHub
# 用法：bash scripts/init-git.sh

set -e

REPO_URL="${REPO_URL:-https://github.com/zhibite/solwallet.git}"
BRANCH="${BRANCH:-main}"

cd "$(dirname "$0")/.."

echo "[1/5] 初始化 git"
if [ ! -d ".git" ]; then
    git init
    git checkout -b "$BRANCH" 2>/dev/null || git branch -M "$BRANCH"
fi

echo "[2/5] 配置 git 用户"
git config user.email "deploy@solwallet.local" 2>/dev/null || true
git config user.name "SolWallet Deploy" 2>/dev/null || true

echo "[3/5] 添加文件"
git add .

echo "[4/5] 检查状态"
git status --short

echo ""
echo "[5/5] 提交"
git commit -m "feat: 初始版本

- 多 RPC 客户端（Helius + 免费源轮询）
- Redis 缓存层（带内存 fallback）
- RPC & 缓存状态页面
- Helius Enhanced Webhook 集成
- Block 深度分析
- 跟单监控 / PnL 计算
- 部署运维脚本（setup/deploy/update/rollback/backup）" || echo "  没有需要提交的变更"

echo ""
echo "准备推送到 $REPO_URL ($BRANCH)"
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"

echo ""
echo "执行推送："
git push -u origin "$BRANCH"

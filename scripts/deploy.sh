#!/bin/bash
#
# SolWallet 首次部署脚本（在 Ubuntu 服务器上执行）
# 用法：
#   sudo bash scripts/deploy.sh
#
# 假设：
#   - 已执行 setup-server.sh
#   - 当前用户是 solwallet（sudo -u solwallet -i 切换）
#   - 服务器可通过 SSH key 拉取 GitHub 仓库
#

set -euo pipefail

APP_NAME="solwallet"
APP_DIR="/opt/solwallet"
REPO_URL="${REPO_URL:-https://github.com/zhibite/solwallet.git}"
BRANCH="${BRANCH:-main}"

echo "================================================"
echo "  首次部署 $APP_NAME"
echo "  仓库: $REPO_URL"
echo "  分支: $BRANCH"
echo "================================================"

cd "$APP_DIR"

# 1. 克隆仓库
echo "[1/6] 克隆仓库"
if [ ! -d ".git" ]; then
    git clone -b "$BRANCH" "$REPO_URL" .
else
    echo "  仓库已存在，跳过克隆"
fi

# 2. 创建日志目录
echo "[2/6] 创建日志目录"
mkdir -p logs

# 3. 配置 .env（如果不存在）
echo "[3/6] 配置 .env"
if [ ! -f ".env" ]; then
    cp .env.example .env

    # 生成安全的随机密钥
    SECRET=$(openssl rand -base64 32)

    # 自动填充 .env
    sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${APP_NAME}_change_me|" .env
    sed -i "s|^REDIS_URL=.*|REDIS_URL=redis://:${APP_NAME}_change_me@127.0.0.1:6379|" .env
    sed -i "s|^HELIUS_API_KEY=.*|HELIUS_API_KEY=PLEASE_FILL_YOUR_KEY|" .env
    sed -i "s|^BIRDEYE_API_KEY=.*|BIRDEYE_API_KEY=|" .env
    sed -i "s|^WEBHOOK_URL=.*|WEBHOOK_URL=https://${APP_NAME}.tokensee.com/api/webhooks/helius|" .env

    echo "  ⚠️  请编辑 .env 填入真实 HELIUS_API_KEY"
    echo "  提示：ssh 到服务器后执行 vim /opt/solwallet/.env"
    read -p "  现在打开 vim 编辑? [Y/n] " yn
    [[ ! "$yn" =~ ^[Nn]$ ]] && vim .env
fi

# 4. 安装依赖
echo "[4/6] 安装依赖"
npm ci --omit=dev

# 5. 构建
echo "[5/6] 构建应用"
npm run build

# 6. 启动
echo "[6/6] 用 PM2 启动"
cd "$APP_DIR"
pm2 delete $APP_NAME 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo ""
echo "================================================"
echo "  部署完成！"
echo ""
echo "  服务状态:  pm2 status"
echo "  查看日志:  pm2 logs $APP_NAME"
echo "  停止服务:  pm2 stop $APP_NAME"
echo "  重启服务:  pm2 restart $APP_NAME"
echo ""
echo "  访问: http://YOUR_SERVER_IP"
echo ""
echo "  后续更新请用：bash scripts/update.sh"
echo "================================================"

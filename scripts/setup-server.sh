#!/bin/bash
#
# SolWallet 服务器初始化脚本（Ubuntu 22.04 / 24.04）
# 用法：在服务器上以 root 执行此脚本（一次性）
#   curl -fsSL https://raw.githubusercontent.com/zhibite/solwallet/main/scripts/setup-server.sh | sudo bash
# 或手动：  sudo bash scripts/setup-server.sh
#
# 会完成：
#   - 创建 solwallet 用户
#   - 安装 Node.js 20 LTS（via nvm）
#   - 安装 PostgreSQL 16
#   - 安装 Redis 7
#   - 安装 Nginx（反向代理）
#   - 安装 PM2 + logrotate
#   - 配置防火墙（仅允许 22 / 80 / 443）
#

set -euo pipefail

APP_NAME="solwallet"
APP_USER="solwallet"
APP_DIR="/opt/solwallet"
APP_PORT=3000
NODE_VERSION="20"

echo "================================================"
echo "  SolWallet 服务器初始化"
echo "  目标用户: $APP_USER"
echo "  应用目录: $APP_DIR"
echo "================================================"

# 1. 创建用户
if ! id "$APP_USER" &>/dev/null; then
    echo "[1/7] 创建用户 $APP_USER"
    useradd -m -s /bin/bash "$APP_USER"
    passwd -l "$APP_USER"  # 锁定密码（仅 SSH key 登录）
else
    echo "[1/7] 用户 $APP_USER 已存在"
fi

# 2. 安装基础包
echo "[2/7] 安装基础包"
apt-get update -y
apt-get install -y curl wget git build-essential ufw fail2ban \
    ca-certificates gnupg lsb-release acl \
    postgresql-16 postgresql-contrib \
    redis-server \
    nginx certbot python3-certbot-nginx

# 3. 安装 nvm + Node.js
echo "[3/7] 安装 Node.js $NODE_VERSION (via nvm)"
NVM_DIR="/usr/local/nvm"
if [ ! -d "$NVM_DIR" ]; then
    mkdir -p "$NVM_DIR"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="/usr/local/nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
fi

# 让 solwallet 用户也能用 nvm
if [ ! -f "/home/$APP_USER/.nvm/nvm.sh" ]; then
    sudo -u "$APP_USER" bash -c "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
fi

# 安装 Node.js 到系统级（更稳）
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
fi

# 4. 安装 PM2
echo "[4/7] 安装 PM2"
npm install -g pm2

# 5. 配置 PostgreSQL
echo "[5/7] 配置 PostgreSQL"
systemctl enable postgresql
systemctl start postgresql

# 创建数据库 + 用户（如果不存在）
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$APP_USER'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE USER $APP_USER WITH PASSWORD '${APP_NAME}_change_me' SUPERUSER;"

sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${APP_NAME}'" | grep -q 1 || \
    sudo -u postgres createdb -O "$APP_USER" "$APP_NAME"

# 6. 配置 Redis
echo "[6/7] 配置 Redis"
systemctl enable redis-server
systemctl start redis-server

# 设置 Redis 密码（建议）
if ! grep -q "^requirepass" /etc/redis/redis.conf; then
    echo "requirepass ${APP_NAME}_change_me" >> /etc/redis/redis.conf
    systemctl restart redis-server
fi

# 7. 配置 Nginx
echo "[7/7] 配置 Nginx"
cat > /etc/nginx/sites-available/$APP_NAME <<EOF
server {
    listen 80;
    server_name solwallet.tokensee.com;

    client_max_body_size 10m;

    # 强制跳 HTTPS（Let's Encrypt 验证后生效）
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name solwallet.tokensee.com;

    ssl_certificate /etc/letsencrypt/live/solwallet.tokensee.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/solwallet.tokensee.com/privkey.pem;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 90;
    }
}
EOF
ln -sf /etc/nginx/sites-available/$APP_NAME /etc/nginx/sites-enabled/$APP_NAME
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# 自动申请 Let's Encrypt SSL 证书（如果域名已解析）
echo ""
echo "================================================"
echo "  检测域名 solwallet.tokensee.com 是否已解析..."
echo "================================================"
if nslookup solwallet.tokensee.com 8.8.8.8 &>/dev/null; then
    echo "  ✅ 域名已解析到: $(nslookup solwallet.tokensee.com 8.8.8.8 | grep -A1 "^Name:" | tail -1 | awk '{print $2}')"
    echo "  正在申请 SSL 证书..."
    if command -v certbot &>/dev/null; then
        certbot --nginx -d solwallet.tokensee.com --noninteractive --agree-tos -m admin@tokensee.com || \
            echo "  ⚠️  SSL 证书申请失败（DNS 可能未完全生效），稍后手动执行："
        echo "     sudo certbot --nginx -d solwallet.tokensee.com"
    else
        echo "  ⚠️  certbot 未安装，稍后手动："
        echo "     sudo apt install -y certbot python3-certbot-nginx"
        echo "     sudo certbot --nginx -d solwallet.tokensee.com"
    fi
else
    echo "  ⚠️  域名 solwallet.tokensee.com 尚未解析到本服务器"
    echo "  请确认 DNS A 记录已指向本服务器 IP 后，手动执行："
    echo "     sudo certbot --nginx -d solwallet.tokensee.com"
fi

# 配置防火墙
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow http
ufw allow https
ufw --force enable

# 启用 PM2 开机自启
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" | tail -1 > /tmp/pm2-startup.sh
bash /tmp/pm2-startup.sh || true

# 创建应用目录
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo ""
echo "================================================"
echo "  初始化完成！"
echo ""
echo "  后续步骤："
echo "  1) 上传 SSH 公钥到 /home/$APP_USER/.ssh/authorized_keys"
echo "  2) 切换到 solwallet 用户：sudo -u $APP_USER -i"
echo "  3) 部署应用：bash /opt/solwallet/scripts/deploy.sh"
echo ""
echo "  PostgreSQL: 用户 $APP_USER / 数据库 $APP_NAME"
echo "  Redis:      127.0.0.1:6379"
echo "  应用端口:   $APP_PORT (Nginx 已配置反向代理)"
echo "================================================"

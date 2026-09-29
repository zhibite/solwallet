# SolWallet 部署指南

完整流程：本地开发 → GitHub → Ubuntu 服务器部署 / 更新

## 架构

```
┌──────────────┐    git push     ┌──────────────┐    pull + restart   ┌──────────────────────┐
│  本地开发     │  ──────────────▶ │   GitHub     │  ─────────────────▶ │  Ubuntu 服务器        │
│  (Windows)   │                  │  zhibite/    │                    │  solwallet.tokensee  │
└──────────────┘                  │  solwallet   │                    │  /opt/solwallet      │
                                   └──────────────┘                    │  PM2 + Nginx + SSL   │
                                                                       │  + PostgreSQL + Redis│
                                                                       └──────────────────────┘
```

## 一次性配置（服务器）

### 1. 准备服务器

要求：Ubuntu 22.04 / 24.04，2GB+ 内存，30GB+ 磁盘，**已配置 SSH 公钥登录**

购买服务器（推荐）：
- 阿里云 ECS（国内访问快）：<https://ecs.aliyun.com>
- AWS Lightsail：<https://lightsail.aws.amazon.com>
- Vultr / DigitalOcean：海外节点

选择 Ubuntu 22.04 LTS，最低 2GB RAM。

### 2. 上传 SSH 公钥

```bash
# 本地执行（已有密钥跳过）
ssh-copy-id root@YOUR_SERVER_IP
```

### 3. 执行初始化脚本

```bash
ssh root@YOUR_SERVER_IP
curl -fsSL https://raw.githubusercontent.com/zhibite/solwallet/main/scripts/setup-server.sh | sudo bash
```

这一步会安装：
- Node.js 20 LTS
- PostgreSQL 16 + 创建 `solwallet` 数据库
- Redis 7
- Nginx
- PM2 进程管理器
- 防火墙（仅放行 22 / 80 / 443）
- 创建 `solwallet` 用户

### 4. 配置 SolWallet 用户的 SSH

```bash
# 本地执行（上传你的公钥给 solwallet 用户）
ssh-copy-id solwallet@YOUR_SERVER_IP
# 或直接用域名（如果 DNS 已生效）
ssh-copy-id solwallet@solwallet.tokensee.com
```

### 5. 配置 SSH Key 用于拉取 GitHub

```bash
ssh solwallet@YOUR_SERVER_IP
ssh-keygen -t ed25519 -C "solwallet-deploy" -N ""
cat ~/.ssh/id_ed25519.pub
```

把公钥添加到 GitHub：<https://github.com/settings/keys>

测试：

```bash
ssh -T git@github.com
# 看到 "Hi zhibite! You've successfully authenticated..." 表示成功
```

### 6. 首次部署

```bash
ssh solwallet@YOUR_SERVER_IP
bash /opt/solwallet/scripts/deploy.sh
```

脚本会：
1. 克隆仓库到 `/opt/solwallet`
2. 生成 `.env`（含默认密码）
3. `npm ci` 安装依赖
4. `npm run build` 构建
5. PM2 启动

按提示填入 `HELIUS_API_KEY` 后，应用会自动启动。

## 日常部署流程

### 步骤 1：本地修改代码

编辑文件后：

```powershell
# 查看变更
git status
git diff

# 提交
git add .
git commit -m "feat: 添加 RPC 状态页"
```

### 步骤 2：推送到 GitHub

```powershell
git push origin main
```

### 步骤 3：服务器更新

```bash
ssh solwallet@YOUR_SERVER_IP
bash /opt/solwallet/scripts/update.sh
```

执行后会自动：
- 备份当前 `.next` 到 `.next.bak`（出问题时可回滚）
- 检查未提交修改（自动 stash）
- `git pull origin main`
- 检测 `package.json` 变更，有变更就 `npm ci`
- `npm run build`
- `pm2 reload solwallet`（零停机）
- 健康检查（curl `/api/rpc/status`）

**整个过程约 1-3 分钟**。

## 常用命令速查

服务器上（`ssh solwallet@YOUR_SERVER_IP` 后）：

```bash
# 查看应用状态
bash /opt/solwallet/scripts/status.sh

# 实时日志
pm2 logs solwallet

# 重启
pm2 restart solwallet

# 停止 / 启动
pm2 stop solwallet
pm2 start solwallet

# 进入应用目录
cd /opt/solwallet
```

数据库：

```bash
# 连接数据库
sudo -u postgres psql solwallet

# 看表
\dt

# 备份
bash /opt/solwallet/scripts/backup.sh

# 恢复
bash /opt/solwallet/scripts/restore.sh 20260929-120000
```

Redis：

```bash
# 连接 Redis
redis-cli -a 'solwallet_change_me'

# 查看键
KEYS *

# 清空缓存（开发用）
FLUSHALL
```

## HTTPS 配置（生产强烈建议）

```bash
ssh solwallet@solwallet.tokensee.com
sudo certbot --nginx -d solwallet.tokensee.com --noninteractive --agree-tos -m admin@tokensee.com
```

Certbot 会自动配置 Nginx 重定向 HTTP → HTTPS。

## 监控与告警（可选）

### 简单方案：PM2 监控

```bash
# 注册 PM2 监控（免费）
pm2 monitor
```

浏览器打开会看到实时 CPU / 内存 / 请求数。

### 进阶方案：UptimeRobot

1. 注册 <https://uptimerobot.com>
2. 添加 Monitor：HTTP(s)，URL `https://solwallet.tokensee.com/api/rpc/status`，间隔 5 分钟
3. 配置告警（邮件）

## 备份策略

```bash
# 添加每日 3 点自动备份
ssh solwallet@YOUR_SERVER_IP
crontab -e

# 添加：
0 3 * * * bash /opt/solwallet/scripts/backup.sh >> /opt/solwallet/logs/backup.log 2>&1
```

备份保留 7 天，自动清理。

## 回滚

```bash
ssh solwallet@solwallet.tokensee.com
bash /opt/solwallet/scripts/rollback.sh

# 回滚到指定 commit
bash /opt/solwallet/scripts/rollback.sh abc1234
```

## 常见问题

### Q1: SSH 拉取 GitHub 失败

```bash
# 确认 SSH key 已添加到 GitHub
ssh -T git@github.com

# 如果失败，把 ~/.ssh/config 添加：
cat >> ~/.ssh/config <<EOF
Host github.com
    StrictHostKeyChecking no
    User git
EOF
```

### Q2: 端口被占用

```bash
sudo lsof -i:3000
# 或者
sudo ss -tlnp | grep 3000
```

### Q3: 数据库迁移出错

```bash
cd /opt/solwallet
cat logs/err.log | tail -50
```

### Q4: 内存不够

2GB 内存的服务器在 `npm run build` 时可能 OOM。临时解决方案：

```bash
# 添加 4GB swap
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Q5: 想看实时构建日志

```bash
ssh solwallet@YOUR_SERVER_IP "bash scripts/update.sh 2>&1" | tee /tmp/update.log
```

## 性能调优

PostgreSQL（`/etc/postgresql/16/main/postgresql.conf`）：

```conf
shared_buffers = 512MB
effective_cache_size = 1.5GB
work_mem = 16MB
maintenance_work_mem = 256MB
```

Redis（`/etc/redis/redis.conf`）：

```conf
maxmemory 512mb
maxmemory-policy allkeys-lru
```

Nginx 启用 gzip（在 `/etc/nginx/nginx.conf` 的 http 块添加）：

```nginx
gzip on;
gzip_types text/plain text/css application/json application/javascript;
```

修改后：

```bash
sudo systemctl reload nginx
```

## 目录结构

```
/opt/solwallet/
├── .next/                 # 构建产物
├── logs/                  # PM2 日志
├── node_modules/
├── src/                   # 源码
├── scripts/               # 运维脚本
│   ├── setup-server.sh    # 服务器初始化
│   ├── deploy.sh          # 首次部署
│   ├── update.sh          # 代码更新
│   ├── rollback.sh        # 回滚
│   ├── backup.sh          # 备份
│   └── restore.sh         # 恢复
├── ecosystem.config.cjs   # PM2 配置
├── .env                   # 环境变量（不要 commit）
└── package.json
```

## 安全清单

部署后确认：

- [ ] 修改 PostgreSQL 密码（默认 `solwallet_change_me`）
- [ ] 修改 Redis 密码
- [ ] 配置 HTTPS（Let's Encrypt）
- [ ] 关闭 root 远程登录：`/etc/ssh/sshd_config` 中 `PermitRootLogin no`
- [ ] 改 SSH 端口（可选）：`/etc/ssh/sshd_config` 中 `Port 2222`
- [ ] 配置 fail2ban（脚本已装）
- [ ] 设置 `HELIUS_API_KEY` 和 `WEBHOOK_URL`
- [ ] 限制 PostgreSQL 远程访问（`/etc/postgresql/16/main/pg_hba.conf`）

```bash
# 修改默认密码
sudo -u postgres psql -c "ALTER USER solwallet WITH PASSWORD 'new-strong-password'"
sudo sed -i "s|POSTGRES_PASSWORD=solwallet_change_me|POSTGRES_PASSWORD=new-strong-password|" /opt/solwallet/.env
pm2 restart solwallet
```

# SolWallet - Solana 跟单抢单监控工具

复刻自截图的 Solana 聪明钱交易分析系统，提供实时监控、Block 级深度分析、PnL 计算、跟单排行等功能。

## 技术栈

- **前端**：Next.js 16 (App Router) + React 19 + TypeScript + TailwindCSS v4
- **后端**：Next.js API Routes（Node.js）
- **数据库**：PostgreSQL 14+
- **数据源**：Helius Enhanced API + 公共 RPC fallback
- **包管理**：npm

## 功能模块

| 页面 | 路由 | 功能 |
|------|------|------|
| 跟单抢单监控 | `/` | 监控目标地址列表、添加 / 暂停 / 删除、详情展开 |
| 跟单目标分析 | `/analysis` | 单地址历史 PnL 分析、一键确认目标 |
| 跟单排行 | `/ranking` | 按 PnL 排序的聪明钱地址排行 |
| 跟单库 | `/library` | 已确认目标的地址池管理 |
| 组合排行 | `/groups` | 经常同 slot 出现的多地址组合 |
| Block 深度分析 | `/block/[slot]/[mint]` | 单笔交易所在 slot 的完整快照 |
| 自己钱包设置 | `/settings/wallets` | 配置「我的账号」用于排位标记 |
| 监控阈值设置 | `/settings/threshold` | 调整每个目标的买入门槛 |
| API 配置 | `/settings/api` | Helius / Birdeye Key 管理 |

## 部署到服务器

完整文档见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

### 部署前确认

- [ ] `solwallet.tokensee.com` DNS A 记录已指向服务器 IP
- [ ] 服务器 SSH 公钥登录已配置
- [ ] GitHub SSH key 已添加到 solwallet 用户

### 一键部署

```bash
# 1. 初始化服务器（安装 Node.js / Postgres / Redis / Nginx / SSL）
ssh root@YOUR_SERVER_IP
curl -fsSL https://raw.githubusercontent.com/zhibite/solwallet/main/scripts/setup-server.sh | sudo bash

# 2. 配置 GitHub SSH
ssh solwallet@YOUR_SERVER_IP
ssh-keygen -t ed25519 -C "solwallet-deploy" -N ""
cat ~/.ssh/id_ed25519.pub   # → 添加到 GitHub Settings → SSH Keys
ssh -T git@github.com       # 验证

# 3. 部署
bash /opt/solwallet/scripts/deploy.sh
# 按提示填入 HELIUS_API_KEY
```

### 日常更新

```powershell
# 本地修改 → push
git add . && git commit -m "feat: xxx" && git push origin main

# 服务器拉取更新
ssh solwallet@solwallet.tokensee.com "bash /opt/solwallet/scripts/update.sh"
```

## 本地开发

```bash
npm install
npm run dev
# 访问 http://localhost:3000
```

## 常用运维命令

| 操作 | 命令 |
|------|------|
| 查看状态 | `bash scripts/status.sh` |
| 查看日志 | `pm2 logs solwallet` |
| 重启 | `pm2 restart solwallet` |
| 回滚 | `bash scripts/rollback.sh` |
| 备份 | `bash scripts/backup.sh` |

### 5. 验证 RPC 和缓存

访问 <http://localhost:3000/settings/rpc> 查看：
- 所有 RPC 端点健康度（成功率、P50/P95 响应时间、熔断状态）
- Redis 缓存命中情况
- 点击「测试一次 getSlot」验证缓存加速比

## 数据流

```
┌────────────────────┐         ┌─────────────────────┐
│  Helius Webhook    │────────▶│ /api/webhooks/helius│
│  或轮询（5s）       │         └─────────┬───────────┘
└────────────────────┘                   │ ingestTargetTrade
                                         ▼
┌────────────────────┐         ┌─────────────────────┐
│   Postgres          │◀────────│  target_trades      │
│  monitored_targets  │         │  block_analyses     │
│  target_trades      │         │  block_buyers       │
│  block_analyses     │         └─────────────────────┘
│  block_buyers       │                   │
│  own_wallets        │                   │ analyzeBlock
│  confirmed_targets  │                   ▼
└────────────────────┘         ┌─────────────────────┐
                               │ getBlock + Helius   │
                               │ Enhanced 解析        │
                               └─────────────────────┘
```

## 核心算法

### 1. 第一个狙击者识别

对一笔目标 buy：
1. 拉取该 buy 所在 slot 的所有交易
2. 解析出所有买入同 MINT 的 tx
3. 按时间偏移排序
4. 第一个 < 目标 blockTime 的买入 = 第一个狙击者

### 2. TIP / PRIO 计算

- **Jito TIP**：从 `nativeTransfers` 中筛选转账给 8 个 Jito tip account 的金额
- **Priority Fee**：从 `ComputeBudget` 指令中读取 `SetComputeUnitPrice` + `SetComputeUnitLimit` 计算

### 3. PnL 计算

```
PnL = 卖出 SOL - 买入 SOL - 手续费 - 失败交易的 tip 损耗
```

### 4. Block 内排位

- 在监控列表配置的 `own_wallets` 集合中
- 对每个 block_buyer 按 `is_own = true` 标记
- 排位 = `block_index + 1`

## 生产部署建议

完整部署 / 更新流程见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

简要流程：
```bash
# 1. 服务器初始化（一次性）
ssh root@YOUR_SERVER_IP
curl -fsSL https://raw.githubusercontent.com/zhibite/solwallet/main/scripts/setup-server.sh | sudo bash

# 2. 首次部署
ssh solwallet@YOUR_SERVER_IP
bash /opt/solwallet/scripts/deploy.sh

# 3. 本地修改 → 推送 → 服务器更新
git add . && git commit -m "feat: xxx" && git push origin main
ssh solwallet@YOUR_SERVER_IP "bash /opt/solwallet/scripts/update.sh"
```

包含的运维脚本（`scripts/`）：

| 脚本 | 用途 | 调用时机 |
|------|------|----------|
| `setup-server.sh` | 安装 Node/Postgres/Redis/Nginx/PM2 | 服务器初始化一次性 |
| `deploy.sh` | 首次部署：clone + 配置 + build + start | 仅首次 |
| `update.sh` | pull + 检测依赖变更 + build + reload | 每次更新 |
| `rollback.sh` | 回滚到上一个 commit | 出问题时 |
| `backup.sh` | 数据库 + Redis + .env 全量备份 | 建议 crontab 每日 3 点 |
| `restore.sh` | 从备份恢复 | 出问题 + 没有更新可用时 |
| `status.sh` | 一键检查应用 / 数据库 / 端口 / 磁盘 | 排错时 |

其他建议：
- **公网域名**：Webhook 需要公网可访问的 URL（推荐 nginx + Let's Encrypt）
- **HTTPS**：`sudo certbot --nginx -d your-domain.com`
- **监控**：PM2 Monitor（免费）或 UptimeRobot（5 分钟心跳）

## 文件结构

```
src/
├── app/
│   ├── (admin)/
│   │   ├── page.tsx                       # 监控首页
│   │   ├── analysis/page.tsx              # 目标分析
│   │   ├── block/[slot]/[mint]/page.tsx   # Block 深度分析
│   │   ├── ranking/page.tsx               # 跟单排行
│   │   ├── library/page.tsx               # 跟单库
│   │   ├── groups/page.tsx                # 组合排行
│   │   └── settings/...                   # 设置子页面
│   └── api/
│       ├── targets/                       # 目标 CRUD
│       ├── transactions/                  # 交易查询
│       ├── block/[slot]/[mint]/           # block 分析查询
│       ├── analyze/                       # 触发分析
│       ├── webhooks/helius/               # Webhook 入口
│       ├── wallets/                       # 自己钱包管理
│       ├── confirm/                       # 一键确认目标
│       ├── export/                        # CSV 导出
│       ├── ranking/                       # 排行数据
│       ├── library/                       # 跟单库 CRUD
│       ├── groups/                        # 组合数据
│       ├── settings/                      # 系统设置
│       └── stats/                         # 全局统计
├── lib/
│   ├── schema.sql                         # DB schema
│   ├── db.ts                              # Postgres pool
│   ├── migrate.ts                         # 自动迁移
│   ├── helius.ts                          # Helius client
│   ├── solana-rpc.ts                      # 公共 RPC fallback
│   ├── parser.ts                          # 交易解析
│   ├── first-sniper.ts                    # 第一个狙击者识别
│   ├── pnl.ts                             # 收益计算
│   ├── dex-price.ts                       # 价格查询
│   ├── monitor.ts                         # 监听 worker
│   └── types.ts                           # 类型定义
├── components/
│   ├── common/                            # 通用组件（AddressCopy, SolAmount, RelativeTime）
│   ├── monitor/                           # 监控页面组件
│   ├── analysis/                          # 分析页面组件
│   └── block/                             # Block 详情组件
└── instrumentation.ts                     # Next.js 启动钩子
```

## License

MIT

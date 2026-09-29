#!/bin/bash
set -e

echo "=== 启动 PostgreSQL ==="
if ! docker ps -a | grep -q solwallet-postgres; then
  docker run -d --name solwallet-postgres \
    -e POSTGRES_DB=solwallet \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=postgres \
    -p 5432:5432 \
    -v solwallet-pgdata:/var/lib/postgresql/data \
    postgres:16
else
  docker start solwallet-postgres
fi

echo "=== 启动 Redis ==="
if ! docker ps -a | grep -q solwallet-redis; then
  docker run -d --name solwallet-redis -p 6379:6379 redis:7-alpine
else
  docker start solwallet-redis
fi

echo "=== 检查 .env ==="
cd "$(dirname "$0")"
if [ ! -f ".env" ]; then
  cp -n .env.example .env
  echo "已生成 .env，请填入 HELIUS_API_KEY"
  exit 1
fi

echo "=== 启动应用 ==="
npm install
npm run dev

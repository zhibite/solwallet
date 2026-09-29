@echo off
REM Windows 本地启动脚本
REM 1) 启动 Postgres + Redis (假设你已经通过 docker desktop / 本地服务安装了)
REM 2) 创建 .env (如果没有)
REM 3) 启动 Next.js dev server

setlocal

echo === 启动 PostgreSQL ===
docker ps -a | findstr solwallet-postgres >nul
if %errorlevel% neq 0 (
    docker run -d --name solwallet-postgres ^
        -e POSTGRES_DB=solwallet ^
        -e POSTGRES_USER=postgres ^
        -e POSTGRES_PASSWORD=postgres ^
        -p 5432:5432 ^
        postgres:16
) else (
    docker start solwallet-postgres >nul 2>&1
)

echo === 启动 Redis (可选) ===
docker ps -a | findstr solwallet-redis >nul
if %errorlevel% neq 0 (
    docker run -d --name solwallet-redis -p 6379:6379 redis:7-alpine
) else (
    docker start solwallet-redis >nul 2>&1
)

echo === 检查 .env ===
if not exist ".env" (
    echo .env 不存在，从 .env.example 复制
    copy .env.example .env
    echo 请编辑 .env 填入你的 HELIUS_API_KEY
    pause
    exit /b 1
)

echo === 启动开发服务 ===
call npm run dev

endlocal

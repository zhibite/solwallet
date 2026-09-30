#!/bin/bash
cd /opt/solwallet
echo "=== git pull ==="
git pull origin main 2>&1 | head -5
echo "=== pnpm build ==="
pnpm build 2>&1 | grep -E "Compiled|Generating|error" | head -8
echo "=== pm2 restart ==="
pm2 restart solwallet 2>&1 | grep -v "update-env"
sleep 5
echo "=== verify ==="
bash /tmp/verify.sh
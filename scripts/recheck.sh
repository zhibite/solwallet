#!/bin/bash
cd /opt/solwallet
set -a; source .env; set +a
echo "=== block_buyers for analysis_id=29 ==="
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT block_index, slot_offset, substring(signature,1,12) AS sig, substring(address,1,8) AS addr, buy_sol, tip_sol, prio_lamports, is_first_sniper, is_follower, is_own, is_pre_target, is_bundled, version FROM block_buyers WHERE block_analysis_id=29 ORDER BY block_index;"
echo "=== 重新分析最新 5 笔缺失 sniper 的 target_trades ==="
ROWS=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "SELECT signature || '|' || slot || '|' || mint FROM target_trades WHERE first_sniper IS NULL ORDER BY block_time DESC LIMIT 5;")
echo "$ROWS"
while IFS='|' read -r SIG SLOT MINT; do
  echo "--- slot=$SLOT mint=$MINT ---"
  curl -s -X POST http://127.0.0.1:3000/api/analyze/block -H 'Content-Type: application/json' -d "{\"slot\":\"$SLOT\",\"mint\":\"$MINT\",\"targetSig\":\"$SIG\"}"
  echo
done <<< "$ROWS"
echo "=== 检查 target_trades 的 first_sniper ==="
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT substring(signature,1,12) AS sig, first_sniper IS NOT NULL AS has_sniper, substring(first_sniper::text,1,8) AS addr, COALESCE(first_sniper_tip_sol::text,'-') AS tip, COALESCE(first_sniper_prio_lamports::text,'-') AS prio FROM target_trades WHERE first_sniper IS NOT NULL ORDER BY block_time DESC LIMIT 5;"
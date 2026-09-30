#!/bin/bash
cd /opt/solwallet
set -a; source .env; set +a
echo "=== 最近 10 笔 target_trades ==="
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT substring(signature,1,12) AS sig, slot, is_bundled, first_sniper IS NOT NULL AS has_sniper, COALESCE(first_sniper_tip_sol::text,'-') AS s_tip, COALESCE(first_sniper_prio_lamports::text,'-') AS s_prio, COALESCE(pnl_sol::text,'-') AS pnl FROM target_trades ORDER BY block_time DESC LIMIT 10;"
echo "=== block_analyses 计数 ==="
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) AS analyses, count(DISTINCT slot) AS slots FROM block_analyses;"
echo "=== block_buyers 计数 ==="
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) AS buyers, count(*) FILTER (WHERE is_first_sniper) AS snipers FROM block_buyers;"
echo "=== 最近 5 笔 block_analyses 错误日志 ==="
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT slot, mint, target_block_index, same_slot_count, next_slot_count, created_at FROM block_analyses ORDER BY created_at DESC LIMIT 5;"
echo "=== err.log 最近 analyzeBlock 错误 ==="
grep -i 'analyzeBlock\|parseBlock' /opt/solwallet/logs/err.log 2>/dev/null | tail -10
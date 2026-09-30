#!/bin/bash
cd /opt/solwallet
set -a; source .env; set +a
echo "=== Backfill target_trades.first_sniper from block_buyers ==="
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
UPDATE target_trades t
SET first_sniper = b.address,
    first_sniper_buy_sol = b.buy_sol,
    first_sniper_tip_sol = b.tip_sol,
    first_sniper_prio_lamports = b.prio_lamports,
    first_sniper_signature = b.signature,
    first_sniper_offset_pos = b.offset_pos
FROM block_buyers b
JOIN block_analyses a ON a.id = b.block_analysis_id
WHERE a.slot = t.slot
  AND a.mint = t.mint
  AND b.is_first_sniper = true
  AND t.first_sniper IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM block_buyers b2
    WHERE b2.block_analysis_id = b.block_analysis_id
      AND b2.is_first_sniper = true
      AND b2.id != b.id
  );
"
echo "=== 结果 ==="
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) AS total, count(first_sniper) AS has_sniper FROM target_trades;"
echo "=== 最近 5 笔（有 sniper 的）==="
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT substring(signature,1,12) AS sig, slot, is_bundled, substring(first_sniper::text,1,8) AS sniper, first_sniper_offset_pos AS pos, COALESCE(first_sniper_tip_sol::text,'-') AS s_tip, COALESCE(first_sniper_prio_lamports::text,'-') AS s_prio FROM target_trades WHERE first_sniper IS NOT NULL ORDER BY block_time DESC LIMIT 5;"
#!/bin/bash
cd /opt/solwallet
set -a; source .env; set +a
LINE=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "SELECT signature, slot, mint FROM target_trades WHERE first_sniper IS NULL ORDER BY block_time DESC LIMIT 1;")
echo "ROW: $LINE"
SIG=$(echo "$LINE" | cut -d'|' -f1)
SLOT=$(echo "$LINE" | cut -d'|' -f2)
MINT=$(echo "$LINE" | cut -d'|' -f3)
echo "Calling /api/analyze/block slot=$SLOT mint=$MINT sig=$SIG"
curl -s -X POST http://127.0.0.1:3000/api/analyze/block -H 'Content-Type: application/json' -d "{\"slot\":\"$SLOT\",\"mint\":\"$MINT\",\"targetSig\":\"$SIG\"}"
echo
echo "=== out.log 最后 10 行 ==="
tail -n 10 /opt/solwallet/logs/out.log
echo "=== err.log 最后 10 行 ==="
tail -n 10 /opt/solwallet/logs/err.log
echo "=== 验证 first_sniper 字段 ==="
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT substring(signature,1,12) AS sig, first_sniper IS NOT NULL AS has_sniper, COALESCE(first_sniper_tip_sol::text,'-') AS s_tip, COALESCE(first_sniper_prio_lamports::text,'-') AS s_prio, is_bundled FROM target_trades WHERE signature = '$SIG';"
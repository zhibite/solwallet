#!/bin/bash
ENV=/opt/solwallet/.env
cp -p "$ENV" "$ENV.bak2"
sed -i 's|,https://solana.rpc.extrnode.com||;s|,https://mainnet.rpcpool.com||;s|,https://api.solscan.io||' "$ENV"
echo "=== AFTER ==="
grep SOLANA_RPCS "$ENV"
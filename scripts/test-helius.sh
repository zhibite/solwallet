#!/bin/bash
KEY="73e3e431-624a-47e4-90c8-dd78627ec2c5"
echo "=== Test 1: getSlot ==="
curl -s -X POST "https://mainnet.helius-rpc.com/?api-key=$KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"t1","method":"getSlot","params":[]}' \
  -w "\nHTTP %{http_code}\n" | head -c 500
echo
echo "=== Test 2: getBlock recent slot ==="
curl -s -X POST "https://mainnet.helius-rpc.com/?api-key=$KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"t2","method":"getBlock","params":[451800466,{"maxSupportedTransactionVersion":1,"transactionDetails":"full"}]}' \
  -w "\nHTTP %{http_code}\n" | head -c 500
echo
echo "=== Test 3: getBlockTime ==="
curl -s -X POST "https://mainnet.helius-rpc.com/?api-key=$KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"t3","method":"getBlockTime","params":[451800466]}' \
  -w "\nHTTP %{http_code}\n"
echo
echo "=== Test 4: Enhanced parse ==="
curl -s -X POST "https://mainnet.helius-rpc.com/v0/transactions/?api-key=$KEY" \
  -H "Content-Type: application/json" \
  -d '{"transactions":["4GTDA78GK9u9dvRHi2gMa7DxWx6nHNNnDMD6aaWY1tNJ8hwKoHx1miJQkpRzExMiuBmpi6UNJeSfYfa6qLj9v129"]}' \
  -w "\nHTTP %{http_code}\n" | head -c 800
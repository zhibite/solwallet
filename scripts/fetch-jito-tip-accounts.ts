// scripts/fetch-jito-tip-accounts.ts
import { writeFileSync } from 'fs';

async function main() {
  const r = await fetch('https://mainnet.block-engine.jito.wtf/api/v1/getTipAccounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
  });
  const j = await r.json();
  console.log(JSON.stringify(j, null, 2));
  if (j.result) writeFileSync('jito-tip-accounts.json', JSON.stringify(j.result, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });

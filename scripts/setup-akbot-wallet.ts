/**
 * 一次性脚本：导入钱包到 akbot 全局配置
 *
 * 用法：
 *   1) 在 .env.local 配 AKBOT_API_KEY / AKBOT_WALLET_PRIVATE_KEY
 *   2) npm run setup:akbot  (= npx tsx scripts/setup-akbot-wallet.ts)
 *   3) 成功后删除本脚本（或在 README 标注「已跑过不要再跑」）
 *
 * 不要重复跑！每次跑会覆盖 akbot 上的 walletPrivateKey。
 */

import { PublicKey, Keypair } from '@solana/web3.js';
import { AkbotClient } from '../src/lib/akbot-client';

async function main() {
  // 加载 .env.local（与 run-migrations.ts 一致）
  const fs = await import('fs');
  for (const path of ['.env.local', '.env']) {
    if (!fs.existsSync(path)) continue;
    for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  const apiKey = process.env.AKBOT_API_KEY;
  const baseUrl = process.env.AKBOT_BASE_URL ?? 'https://api.akbot.pro/api';
  const privateKey = process.env.AKBOT_WALLET_PRIVATE_KEY;

  if (!apiKey) throw new Error('AKBOT_API_KEY missing in .env');
  if (!privateKey) throw new Error('AKBOT_WALLET_PRIVATE_KEY missing in .env');

  // 推 pubkey
  let pubkey: string;
  try {
    // 支持 base58 字符串 或 JSON 数组（[1,2,3,...]）
    if (privateKey.trim().startsWith('[')) {
      const arr = JSON.parse(privateKey) as number[];
      pubkey = Keypair.fromSecretKey(Uint8Array.from(arr)).publicKey.toBase58();
    } else {
      // base58 解码（@scure/base 内置在 web3.js 链上，避免额外依赖）
      const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      const ALPHABET_MAP: Record<string, number> = {};
      for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET[i]] = i;
      const bytes: number[] = [];
      for (const ch of privateKey) {
        if (!(ch in ALPHABET_MAP)) throw new Error(`非 base58 字符: ${ch}`);
        let carry = ALPHABET_MAP[ch];
        for (let i = 0; i < bytes.length; i++) {
          carry += bytes[i] * 58;
          bytes[i] = carry & 0xff;
          carry >>= 8;
        }
        while (carry > 0) {
          bytes.push(carry & 0xff);
          carry >>= 8;
        }
      }
      for (const ch of privateKey) {
        if (ch === '1') break;
        bytes.push(0);
      }
      pubkey = Keypair.fromSecretKey(Uint8Array.from(bytes.reverse())).publicKey.toBase58();
    }
  } catch (e) {
    throw new Error(`解析 AKBOT_WALLET_PRIVATE_KEY 失败：${e instanceof Error ? e.message : e}`);
  }

  console.log('[setup-akbot] pubkey =', pubkey);
  console.log('[setup-akbot] base   =', baseUrl);
  console.log('[setup-akbot] calling importWallet...');

  // 用 client 的 importWallet 而不是手写 fetch：跟 agent 那边走同一条 baseUrl/header/timeout
  // 路径，避免后面 client 改了 endpoint 脚本漏改。
  const client = new AkbotClient({ baseUrl, apiKey });
  const r = await client.importWallet({
    walletPubKey: pubkey,
    walletPrivateKey: privateKey,
    walletNote: 'agent-managed',
    sellTip: 0.001,
    sellGas: 0.00001,
  });

  console.log('[setup-akbot] status:', r.status);
  console.log('[setup-akbot] body  :', JSON.stringify(r.body).slice(0, 500));
  console.log('[setup-akbot] took  :', r.durationMs, 'ms');

  if (!r.ok) {
    console.error('[setup-akbot] failed:', r.error);
    process.exit(1);
  }
  console.log('[setup-akbot] ✓ 钱包导入成功');
  console.log('[setup-akbot] 接下来：');
  console.log('  1) 在 agent UI 把 shadow_mode 调成 true 跑 1-2 轮看决策');
  console.log('  2) 没问题就切 false 启用真实执行');
  console.log('  3) 看 akbot_call_log 表确认调用成功');
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});

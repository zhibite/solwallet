/**
 * 管理 Helius Webhooks
 *
 * 背景：Helius webhook 一旦注册就会一直产生推送事件（1 cr/事件），并且
 *       跟"注册时用的 API key"绑定。把 .env 里 HELIUS_USE_WEBHOOK=false
 *       只能让本地代码走 polling 分支，**Helius 那边已注册的 webhook 不会
 *       自动取消**——必须显式 DELETE。
 *
 * 用法（tsx + --env-file=.env）：
 *   npx tsx --env-file=.env scripts/manage-webhooks.ts                          # 只列出
 *   npx tsx --env-file=.env scripts/manage-webhooks.ts --delete <webhookID...>   # 按 ID 删
 *   npx tsx --env-file=.env scripts/manage-webhooks.ts --delete-others          # 删全部（保留一个，需要
 *                                                                            #   先用 --keep-by-url 选保留谁）
 *   npx tsx --env-file=.env scripts/manage-webhooks.ts --keep-by-url <URL>      # 与 --delete-others 配合，
 *                                                                            #   只删 URL 不匹配的全部 webhook
 *   npx tsx --env-file=.env scripts/manage-webhooks.ts --delete-all --yes      # 删全部（危险）
 *
 * 不带 --delete* 标志时只列出来，不会动 Helius。
 */
import { readFileSync } from 'fs';

// 直接复用项目里已有的客户端，避免引入 getHelius() 间接拉起 monitor / instrumentation
import { HeliusClient, isHeliusConfigured } from '../src/lib/helius';

// ---- 简易 .env 加载（与 probe-helius.ts / scripts/monitor.ts 风格一致）----
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

// ---- 参数解析 ----
const argv = process.argv.slice(2);
const flags = new Set<string>();
const positional: string[] = [];
const flagValue: Record<string, string> = {};
// 需要带值（" " 分隔也支持）的 flag
const VALUED_FLAGS = new Set(['keep-by-url']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) {
      flagValue[a.slice(2, eq)] = a.slice(eq + 1);
      flags.add(a.slice(2, eq));
    } else {
      flags.add(a.slice(2));
      // 一些带值 flag（如 --keep-by-url）支持 " " 分隔：拿 argv[i+1] 作为值
      // 仅当下一项不是以 -- 开头时才消费，避免把下一个 flag 当成值
      if (VALUED_FLAGS.has(a.slice(2)) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flagValue[a.slice(2)] = argv[i + 1];
        i++;
      }
    }
  } else {
    positional.push(a);
  }
}

const deleteIds = positional; // --delete <id1> <id2> ...
const deleteOthers = flags.has('delete-others');
const deleteAll = flags.has('delete-all');
const yes = flags.has('yes');
const keepUrl = flagValue['keep-by-url'];

if (!isHeliusConfigured()) {
  console.error('❌ HELIUS_API_KEY 未配置，请检查 .env');
  process.exit(1);
}

const helius = new HeliusClient(process.env.HELIUS_API_KEY!);

// ---- 主流程 ----
async function main() {
  const list = await helius.listWebhooks();
  console.log(`\n当前注册在 API key "${helius.apiKey.slice(0, 8)}…" 下的 webhooks：`);

  if (list.length === 0) {
    console.log('  (空) — 没有遗留的 webhook，Helius 不会再向你推送事件');
    console.log('\n如确认是误用导致的 25K Webhook 消耗，请去 dashboard 看历史用量是否在清理后停止增长。\n');
    return;
  }

  console.log('');
  list.forEach((w, i) => {
    console.log(`  [${i + 1}] webhookID:    ${w.webhookID}`);
    console.log(`      webhookURL:   ${w.webhookURL}`);
    console.log(`      webhookType:  ${w.webhookType}`);
    console.log(`      txTypes:      ${(w.transactionTypes || []).join(', ')}`);
    console.log(`      addresses:    ${(w.accountAddresses ?? []).length} 个`);
    const addrs = w.accountAddresses ?? [];
    if (addrs.length <= 5) {
      for (const a of addrs) console.log(`                     - ${a}`);
    } else {
      console.log(`                     - ${addrs.slice(0, 3).join('\n                     - ')} … 等 ${addrs.length} 个`);
    }
    console.log('');
  });

  // 没有删除意图 → 退出
  if (deleteIds.length === 0 && !deleteOthers && !deleteAll) {
    console.log('未传 --delete / --delete-others / --delete-all，列出后退出。');
    console.log('若要清理，请带对应 flag 重跑（见脚本顶部注释）。\n');
    return;
  }

  // ---- 计算要删除的 ID ----
  let toDelete: string[] = [];
  let reason = '';

  if (deleteIds.length > 0) {
    const knownIds = new Set(list.map((w) => w.webhookID));
    for (const id of deleteIds) {
      if (!knownIds.has(id)) {
        console.error(`❌ webhookID ${id} 不在列表中，跳过`);
        continue;
      }
      toDelete.push(id);
    }
    reason = `按 ID 显式删除（${toDelete.length} 个）`;
  } else if (deleteOthers) {
    if (keepUrl) {
      toDelete = list.filter((w) => w.webhookURL !== keepUrl).map((w) => w.webhookID);
      reason = `保留 URL = "${keepUrl}" 的 webhook，其余删除`;
    } else {
      console.error('❌ --delete-others 必须配合 --keep-by-url=<URL> 使用，否则会清空所有 webhook');
      process.exit(1);
    }
  } else if (deleteAll) {
    if (!yes) {
      console.error('❌ --delete-all 会清空所有 webhook，必须再带 --yes 确认');
      process.exit(1);
    }
    toDelete = list.map((w) => w.webhookID);
    reason = `全部清空（${list.length} 个）`;
  }

  if (toDelete.length === 0) {
    console.log('\n没有匹配到要删除的 webhook，退出。');
    return;
  }

  console.log(`\n⚠️  准备执行：${reason}`);
  console.log(`    待删 ID：${toDelete.join(', ')}`);
  if (!yes) {
    console.log('\n    请加 --yes 确认后再跑（脚本默认 dry-run）。');
    return;
  }

  // ---- 执行删除 ----
  let ok = 0, fail = 0;
  for (const id of toDelete) {
    try {
      await helius.deleteWebhook(id);
      console.log(`  ✅ deleted ${id}`);
      ok++;
    } catch (err: any) {
      console.error(`  ❌ failed ${id}: ${err?.message ?? String(err)}`);
      fail++;
    }
  }

  console.log(`\n完成：成功 ${ok}，失败 ${fail}`);
  if (ok > 0) {
    console.log('建议等几分钟回到 Helius dashboard，确认 Webhooks 用量开始停止增长。\n');
  }
}

main().catch((err) => {
  console.error('脚本异常:', err);
  process.exit(1);
});
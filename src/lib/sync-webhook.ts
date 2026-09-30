/**
 * 触发 Helius webhook 重新同步（fire-and-forget）
 *
 * 为什么用 setImmediate + mutex：
 * 1) 用户在 UI 连续添加/暂停/删除多个 target 时，每个 handler 都会调一次。
 * 2) 不想阻塞 HTTP 响应（Helius API 往返 ~500ms）。
 * 3) 防抖合并：连续触发只跑一次最终的 sync，避免浪费 Helius 配额。
 *
 * 设计：第一次触发后 800ms 内合并；定时器到期后才真正发起 API call。
 * 这样 "POST 3 次" 只产生 1 次 listWebhooks + 1 次 update。
 */

import { registerWebhooks } from './monitor';
import { isHeliusConfigured } from './helius';

const DEBOUNCE_MS = 800;

let timer: NodeJS.Timeout | null = null;
let inflight = false;

export function syncWebhookAsync() {
  if (!isHeliusConfigured()) return;
  if (timer || inflight) {
    // 已经在等/在跑，重置定时器继续合并
    if (timer) clearTimeout(timer);
  }
  timer = setTimeout(async () => {
    timer = null;
    if (inflight) return; // 上一次还没完，下次再触发
    inflight = true;
    try {
      await registerWebhooks();
    } catch (err) {
      console.warn('[sync-webhook] failed', err);
    } finally {
      inflight = false;
    }
  }, DEBOUNCE_MS);
}

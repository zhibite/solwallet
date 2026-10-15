/**
 * 通用并发工具：从 first-sniper.ts 抽出来供 analyze 等模块复用。
 *
 * 约定：
 *   - 任务按入参下标写回 results（保持调用方传参顺序的语义）
 *   - 每个 worker 完成后立刻接班下一个（不是等所有 worker 都完成一轮才继续），最大化吞吐
 *   - 单个任务的异常不会被吞掉：会向上抛，由调用方决定怎么包 try/catch
 *   - 并发上限 = min(concurrency, items.length)，传入 0/负数时退化为 1
 */

/**
 * 把 N 个任务按并发上限并行执行，按入参顺序返回结果。
 *
 * @param items       输入列表
 * @param concurrency 并发上限；> 0 时取这个值，<=0 时退化为 1
 * @param worker      单个任务的处理函数
 * @param onProgress  每完成一个任务回调一次（done, total），可选
 * @returns           与 items 等长的结果数组（按 items 下标对齐）
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const cap = Math.max(1, Math.min(concurrency, items.length));
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let cursor = 0;
  let done = 0;

  async function next(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } finally {
        done++;
        onProgress?.(done, items.length);
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => next()));
  return results;
}

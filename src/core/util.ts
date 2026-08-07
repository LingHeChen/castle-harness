/** Cap tool output so a single noisy command can't blow up the context window. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return text.slice(0, max) + `\n... [truncated ${dropped} chars]`;
}

/**
 * Run `fn` over `items` with bounded concurrency, preserving input→output order.
 * `limit` worker "lanes" pull from a shared cursor, so up to `limit` calls are
 * genuinely in flight at once (true parallelism for independent async work like
 * per-task subagents), without spawning an unbounded number of model calls.
 */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: lanes }, worker));
  return results;
}

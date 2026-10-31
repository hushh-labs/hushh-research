/**
 * Run `task` over `items` with at most `limit` in flight, settling every item.
 *
 * A grouped request is decided one server call per item, because each item is
 * its own security decision (there is no bulk decision endpoint, and inventing
 * one is not a client's call). Running those calls strictly one after another
 * made a five-item Allow take five round trips of wall time; running all of them
 * at once would build five encrypted exports concurrently on a phone. A small
 * bound keeps both costs honest.
 *
 * Never rejects: each item's outcome is reported, so a caller can say exactly
 * how many went through instead of stopping at the first failure and leaving the
 * rest undecided without saying so.
 */
export type SettledItem<T> =
  | { item: T; ok: true }
  | { item: T; ok: false; error: unknown };

export async function settleWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
  onProgress?: (settled: number, total: number) => void,
): Promise<SettledItem<T>[]> {
  const bound = Math.max(1, Math.floor(limit));
  const results: SettledItem<T>[] = new Array(items.length);
  let next = 0;
  let settled = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index]!;
      try {
        await task(item);
        results[index] = { item, ok: true };
      } catch (error) {
        results[index] = { item, ok: false, error };
      }
      settled += 1;
      onProgress?.(settled, items.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(bound, items.length) }, () => worker()),
  );
  return results;
}

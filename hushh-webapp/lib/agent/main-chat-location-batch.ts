// Match the Location workspace's bounded audience fanout. Plans for one origin
// share a server lock, so sending the whole Circle at once consumes DB waiters.
const LOCATION_BATCH_CONCURRENCY = 4;

export async function settleMainLocationBatch<T, R>(
  items: readonly T[],
  run: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(LOCATION_BATCH_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await run(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}

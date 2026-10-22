/**
 * One shard setting for every Playwright invocation, including chained packs.
 * @param {string | undefined} raw
 * @returns {{current: number, total: number} | undefined}
 */
function parsePlaywrightShard(raw) {
  if (!raw) return undefined;
  if (!/^[1-9][0-9]*\/[1-9][0-9]*$/.test(raw)) {
    throw new Error("PLAYWRIGHT_SHARD must be current/total positive integers");
  }
  const [current, total] = raw.split("/").map(Number);
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total) || current > total) {
    throw new Error("PLAYWRIGHT_SHARD must be current/total with 1 <= current <= total and safe integer bounds");
  }
  return { current, total };
}

module.exports = { parsePlaywrightShard };

if (require.main === module) {
  const shard = parsePlaywrightShard(process.env.PLAYWRIGHT_SHARD);
  process.stdout.write(!shard || shard.current === 1 ? "1\n" : "0\n");
}

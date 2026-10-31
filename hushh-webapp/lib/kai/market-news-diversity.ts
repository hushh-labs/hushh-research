import type { KaiHomeNewsItem } from "@/lib/services/api-service";

function canonicalNewsUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|campaign$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function canonicalHeadline(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Keeps the visible tape source-backed while preventing one symbol from
 * consuming every slot. Input order remains the recency authority inside
 * each symbol bucket; this function only interleaves those buckets.
 */
export function diversifyMarketNewsRows(
  rows: readonly KaiHomeNewsItem[],
  options: { maxPerSymbol?: number } = {},
): KaiHomeNewsItem[] {
  const maxPerSymbol = Math.max(1, options.maxPerSymbol ?? 2);
  const seenHeadlines = new Set<string>();
  const seenUrls = new Set<string>();
  const buckets = new Map<string, KaiHomeNewsItem[]>();

  for (const row of rows) {
    const title = canonicalHeadline(String(row.title || ""));
    const url = canonicalNewsUrl(String(row.url || ""));
    if (!title || !url) continue;
    if (seenHeadlines.has(title) || seenUrls.has(url)) continue;
    seenHeadlines.add(title);
    seenUrls.add(url);

    const symbol = String(row.symbol || "MARKET").trim().toUpperCase() || "MARKET";
    const bucket = buckets.get(symbol) ?? [];
    if (bucket.length >= maxPerSymbol) continue;
    bucket.push(row);
    buckets.set(symbol, bucket);
  }

  const diversified: KaiHomeNewsItem[] = [];
  const bucketRows = [...buckets.values()].sort((left, right) => {
    const leftTime = Date.parse(String(left[0]?.published_at || ""));
    const rightTime = Date.parse(String(right[0]?.published_at || ""));
    return (Number.isFinite(rightTime) ? rightTime : 0) -
      (Number.isFinite(leftTime) ? leftTime : 0);
  });
  for (let index = 0; ; index += 1) {
    let appended = false;
    for (const bucket of bucketRows) {
      const row = bucket[index];
      if (!row) continue;
      diversified.push(row);
      appended = true;
    }
    if (!appended) break;
  }
  return diversified;
}

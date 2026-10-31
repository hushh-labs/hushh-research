import type { KaiMarketCompanyFacts } from "@/lib/services/api-service";

/** Bounded page batching; transport/auth remain with ApiService on web/native. */
export async function readKaiCompanyFacts(
  data: { userId: string; symbols: string[]; signal?: AbortSignal },
  authToken: string,
  request: (path: string, options: RequestInit) => Promise<Response>,
): Promise<Record<string, KaiMarketCompanyFacts>> {
  const unique = [...new Set(data.symbols)].slice(0, 24);
  const chunks = Array.from({ length: Math.ceil(unique.length / 8) }, (_, index) => unique.slice(index * 8, index * 8 + 8));
  const results = await Promise.allSettled(chunks.map(async symbols => {
    const query = new URLSearchParams({ symbols: symbols.join(",") });
    const response = await request(`/api/kai/market/company-facts/${data.userId}?${query}`, {
      method: "GET", signal: data.signal,
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) throw new Error(`Company facts unavailable: ${response.status}`);
    return (await response.json()).facts as Record<string, KaiMarketCompanyFacts>;
  }));
  const facts: Record<string, KaiMarketCompanyFacts> = {};
  results.forEach((result, index) => {
    if (result.status === "fulfilled") Object.assign(facts, result.value);
    else for (const symbol of chunks[index] ?? []) facts[symbol] = { symbol, unavailable: true };
  });
  return facts;
}

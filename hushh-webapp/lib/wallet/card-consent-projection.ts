/** Defense for historical manifests and caches. Does not widen approved scopes. */
export function projectWalletConsent(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const domain = value as Record<string, unknown>, result: Record<string, unknown> = {};
  for (const branch of ["summary", "secrets"] as const) {
    const input = domain[branch];
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    const cards: Record<string, unknown> = {};
    for (const [id, row] of Object.entries(input)) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const permitted = branch === "summary" ? ["nickname", "brand", "last4", "expiry_month", "expiry_year", "issuing_region", "created_at"] : ["pan", "cardholder_name"];
      const fields = Object.fromEntries(permitted.flatMap(key => { const field = (row as Record<string, unknown>)[key]; return typeof field === "string" || typeof field === "number" ? [[key, field]] : []; }));
      if (Object.keys(fields).length) cards[id] = fields;
    }
    if (Object.keys(cards).length) result[branch] = cards;
  }
  return result;
}

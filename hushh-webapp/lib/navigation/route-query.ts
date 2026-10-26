/** Merge explicit query values without mutating a caller-owned URLSearchParams object. */
export function withQuery(
  pathname: string,
  entries: Record<string, string | null | undefined>,
) {
  const [basePath = pathname, existingQuery = ""] = pathname.split("?", 2);
  const params = new URLSearchParams(existingQuery);

  for (const [key, value] of Object.entries(entries)) {
    const normalized = String(value ?? "").trim();
    if (normalized) {
      params.set(key, normalized);
    }
  }

  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

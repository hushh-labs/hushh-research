/** Keep the displayed record inside its approved domain envelope. */
export function projectGrantPayload(
  payload: Record<string, unknown>,
  domain: string | null | undefined,
): Record<string, unknown> {
  const requestedDomain = String(domain || "").trim().toLowerCase();
  if (!requestedDomain) return payload;
  const domainEntry = Object.entries(payload).find(
    ([key, value]) => key.toLowerCase() === requestedDomain && value && typeof value === "object" && !Array.isArray(value),
  )?.[1];
  return domainEntry && typeof domainEntry === "object" && !Array.isArray(domainEntry)
    ? domainEntry as Record<string, unknown>
    : payload;
}

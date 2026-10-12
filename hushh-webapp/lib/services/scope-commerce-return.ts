/** Opaque arrivals are refresh hints, never financial or information authority. */
export type CommerceReturnAction = "onboarding_refresh";
export type CommerceReturn = { attemptId: string; action?: CommerceReturnAction };
export type CommerceHostedSession = { url: string; returnUrl: string; attemptId: string };

export function parseCommerceReturn(path: string): CommerceReturn | null {
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  let url: URL;
  try { url = new URL(path, "https://one.hushh.ai"); } catch { return null; }
  if (url.origin !== "https://one.hushh.ai" || url.pathname !== "/one/profile/account" || [...url.searchParams.keys()].some(key => !["commerceReturn", "commerceAttemptId", "commerceAction"].includes(key)) || url.searchParams.getAll("commerceReturn").length !== 1 ||
      url.searchParams.get("commerceReturn") !== "1" || url.searchParams.getAll("commerceAttemptId").length !== 1 || url.hash) return null;
  const id = url.searchParams.get("commerceAttemptId") || "";
  const actions = url.searchParams.getAll("commerceAction");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id) || actions.length > 1 ||
      (actions.length === 1 && actions[0] !== "onboarding_refresh")) return null;
  return { attemptId: id, ...(actions.length ? { action: "onboarding_refresh" as const } : {}) };
}

export function commerceReturnAttempt(path: string): string | null {
  return parseCommerceReturn(path)?.attemptId ?? null;
}

export function commerceReturnAction(path: string): CommerceReturnAction | null {
  return parseCommerceReturn(path)?.action ?? null;
}

export function parseCommerceHostedSession(value: Record<string, unknown>, attemptId: string): CommerceHostedSession {
  if (typeof value.url !== "string" || typeof value.return_url !== "string") {
    throw new Error("The payment return address could not be verified. Refresh before continuing.");
  }
  const url = new URL(value.return_url);
  const arrival = parseCommerceReturn(url.pathname + url.search + url.hash);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      arrival?.attemptId !== attemptId || arrival.action) {
    throw new Error("The payment return address could not be verified. Refresh before continuing.");
  }
  return { url: value.url, returnUrl: url.href, attemptId };
}

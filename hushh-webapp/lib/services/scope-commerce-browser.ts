import { Capacitor } from "@capacitor/core";

export type CommerceHostedPurpose = "checkout" | "onboarding";

/** Provider destinations are presentation only; their returns never authorize sharing. */
export function validateCommerceHostedUrl(raw: string, purpose: CommerceHostedPurpose): string {
  const url = new URL(raw);
  const hosts = purpose === "checkout"
    ? ["checkout.stripe.com"]
    : ["connect.stripe.com"];
  if (url.protocol !== "https:" || !hosts.includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error("The payment provider address could not be verified.");
  }
  return url.href;
}

export async function openCommerceHostedUrl(raw: string, purpose: CommerceHostedPurpose): Promise<void> {
  const url = validateCommerceHostedUrl(raw, purpose);
  if (Capacitor.isNativePlatform()) {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
    return;
  }
  const { assignWindowLocation } = await import("@/lib/utils/browser-navigation");
  assignWindowLocation(url);
}

export const COMMERCE_RETURN_EVENT = "hushh:commerce-return";
export type CommerceReturnAction = "onboarding_refresh";
export type CommerceReturn = { attemptId: string; action?: CommerceReturnAction };

/** Opaque provider arrival is only a prompt to re-read server settlement. */
function parseCommerceReturn(path: string): CommerceReturn | null {
  // This parser consumes an in-app path after the native origin check, or web
  // pathname + search. An absolute URL must never bypass that check.
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

/** Presentation only: close the hosted browser and announce a validated arrival. */
export function announceCommerceReturn(path: string): void {
  const arrival = parseCommerceReturn(path);
  if (!arrival) return;
  void import("@capacitor/browser").then(({ Browser }) => Browser.close()).catch(() => undefined);
  window.dispatchEvent(new CustomEvent<CommerceReturn>(COMMERCE_RETURN_EVENT, { detail: arrival }));
}

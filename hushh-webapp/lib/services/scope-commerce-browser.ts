import { Capacitor } from "@capacitor/core";
import { openOAuthWindow } from "@/lib/connections/oauth-window";
import { waitForOAuthPopup } from "@/lib/profile/drive-oauth-popup";
import { parseCommerceReturn, type CommerceHostedSession, type CommerceReturn, type CommerceReturnSource } from "./scope-commerce-return";
export { commerceReturnAction, commerceReturnAttempt } from "./scope-commerce-return";
export type { CommerceReturn, CommerceReturnAction } from "./scope-commerce-return";

export type CommerceHostedPurpose = "checkout" | "onboarding";

/** Provider destinations are presentation only; their returns never authorize sharing. */
export function validateCommerceHostedUrl(raw: string, purpose: CommerceHostedPurpose | "management"): string {
  const url = new URL(raw);
  const hosts = purpose === "checkout"
    ? ["checkout.stripe.com"]
    : purpose === "management" ? ["connect.stripe.com", "stripe.com"] : ["connect.stripe.com"];
  if (url.protocol !== "https:" || !hosts.includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error("The payment provider address could not be verified.");
  }
  return url.href;
}

/** Open directly inside the trusted click, before requesting a provider link. */
export function openCommerceHostedWindow(): Window | null {
  if (Capacitor.isNativePlatform()) return null;
  const popup = openOAuthWindow(`one-commerce-${crypto.randomUUID()}`)?.target ?? null;
  if (popup) {
    try {
      popup.opener = null;
      popup.document.title = "Secure payment setup";
      popup.document.body.textContent = "Opening Stripe… Your One session stays in its original window.";
    } catch { /* The placeholder is cosmetic. */ }
  }
  return popup;
}

const MARKER_PREFIX = "one_commerce_popup_v1:";
const RETURN_KEY = "one_commerce_popup_return_v1";
const WINDOW_LIFETIME_MS = 10 * 60_000;
type PopupMarker = { attemptId: string; purpose: CommerceHostedPurpose; expiresAt: number; source?: CommerceReturnSource };

const markerKey = (attemptId: string, source?: CommerceReturnSource) => MARKER_PREFIX + (source ? `${source}:` : "") + attemptId;

function readMarker(attemptId: string, source?: CommerceReturnSource): PopupMarker | null {
  try {
    const raw = window.localStorage.getItem(markerKey(attemptId, source));
    if (!raw) return null;
    const value = JSON.parse(raw) as PopupMarker;
    return value.attemptId === attemptId && value.source === source && ["checkout", "onboarding"].includes(value.purpose) &&
      Number.isFinite(value.expiresAt) && value.expiresAt > Date.now() &&
      value.expiresAt <= Date.now() + WINDOW_LIFETIME_MS &&
      (value.source === undefined || (["documents", "answers"].includes(value.source) && value.purpose === "onboarding")) &&
      Object.keys(value).every(key => ["attemptId", "purpose", "expiresAt", "source"].includes(key)) ? value : null;
  } catch { return null; }
}

export function hasCommercePopupReturn(path: string): boolean {
  const arrival = parseCommerceReturn(path);
  if (!arrival || Capacitor.isNativePlatform()) return false;
  const marker = readMarker(arrival.attemptId, arrival.source);
  return Boolean(marker && arrival.source === marker.source && (!arrival.action || marker.purpose === "onboarding"));
}

export async function openCommerceHostedUrl(session: CommerceHostedSession, purpose: CommerceHostedPurpose, popup: Window | null, signal: AbortSignal): Promise<void> {
  const url = validateCommerceHostedUrl(session.url, purpose);
  if (signal.aborted) return;
  const callback = new URL(session.returnUrl);
  const arrival = parseCommerceReturn(callback.pathname + callback.search + callback.hash);
  if (arrival?.attemptId !== session.attemptId || arrival.source !== session.source ||
      (session.source && purpose !== "onboarding")) {
    throw new Error("Stripe return binding could not be verified.");
  }
  if (Capacitor.isNativePlatform()) {
    const { Browser } = await import("@capacitor/browser");
    if (signal.aborted) return;
    await Browser.open({ url });
    return;
  }
  if (callback.origin !== window.location.origin || !popup || popup.closed ||
      arrival?.attemptId !== session.attemptId || arrival.source !== session.source ||
      (session.source && purpose !== "onboarding")) {
    throw new Error("Stripe cannot return to this window. Refresh before trying again.");
  }
  const marker: PopupMarker = { attemptId: session.attemptId, purpose, expiresAt: Date.now() + WINDOW_LIFETIME_MS, ...(session.source ? { source: session.source } : {}) };
  const key = markerKey(marker.attemptId, marker.source);
  // Only opaque correlation persists. The owner, tokens and vault keys remain
  // in the initiating document; all notifications require authenticated reads.
  window.localStorage.setItem(key, JSON.stringify(marker));
  try {
    const matches = (value: unknown) => {
      if (!value || typeof value !== "object") return false;
      const hint = value as PopupMarker & { type?: string; action?: string };
      return hint.type === "commerce_return" && hint.attemptId === marker.attemptId &&
        hint.source === marker.source &&
        hint.purpose === purpose && hint.expiresAt === marker.expiresAt &&
        (!hint.action || (purpose === "onboarding" && hint.action === "onboarding_refresh")) &&
        Object.keys(hint).every(name => ["type", "attemptId", "purpose", "expiresAt", "action", "source"].includes(name));
    };
    const returned = waitForOAuthPopup({
      popup, signal, expiresAt: marker.expiresAt,
      matches,
      storageValue: event => {
        if (event.key !== RETURN_KEY || !event.newValue) return null;
        try {
          const value = JSON.parse(event.newValue) as CommerceReturn;
          if (matches(value)) window.dispatchEvent(new CustomEvent(COMMERCE_RETURN_EVENT, { detail: value }));
          return value;
        } catch { return null; }
      },
    });
    popup.location.replace(url);
    await returned;
  } finally {
    window.localStorage.removeItem(key);
    try {
      const hint = JSON.parse(window.localStorage.getItem(RETURN_KEY) ?? "null") as PopupMarker | null;
      if (hint?.attemptId === marker.attemptId && hint.source === marker.source && hint.purpose === marker.purpose && hint.expiresAt === marker.expiresAt) {
        window.localStorage.removeItem(RETURN_KEY);
      }
    } catch { /* A malformed or another flow's hint belongs to neither this attempt nor its cleanup. */ }
  }
}

export const COMMERCE_RETURN_EVENT = "hushh:commerce-return";

/** Callback-only shell: no authentication, keys or Account information here. */
export function notifyCommercePopupReturn(path: string): boolean {
  if (!hasCommercePopupReturn(path)) return false;
  const arrival = parseCommerceReturn(path)!;
  const marker = readMarker(arrival.attemptId, arrival.source)!;
  const hint = { type: "commerce_return", ...marker, ...arrival };
  try {
    const serialized = JSON.stringify(hint);
    window.localStorage.setItem(RETURN_KEY, serialized);
    window.setTimeout(() => {
      if (window.localStorage.getItem(RETURN_KEY) === serialized) window.localStorage.removeItem(RETURN_KEY);
    }, 3000);
    window.close();
    return true;
  } catch { return false; }
}

/** Presentation only: close the hosted browser and announce a validated arrival. */
export function announceCommerceReturn(path: string): void {
  const arrival = parseCommerceReturn(path);
  if (!arrival) return;
  void import("@capacitor/browser").then(({ Browser }) => Browser.close()).catch(() => undefined);
  window.dispatchEvent(new CustomEvent<CommerceReturn>(COMMERCE_RETURN_EVENT, { detail: arrival }));
}

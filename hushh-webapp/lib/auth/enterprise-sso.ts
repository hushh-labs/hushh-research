/**
 * Enterprise SSO (WorkOS) client helpers: pending-attempt storage and the
 * callback decision. Pure and framework-free so the security rule is testable.
 *
 * The backend signs and expires the `state` and binds it to an org, but it
 * cannot know which browser started the sign-in. This module closes that gap:
 * the state is stored in the starting tab's sessionStorage and the callback is
 * honored only when the returned state matches it exactly, once. That is the
 * login-CSRF defense (a code minted for someone else's sign-in is refused).
 *
 * SSO proves identity only. Nothing here touches the vault: a signed-in
 * enterprise user still unlocks with their own passphrase.
 */

const PENDING_KEY = "hushh.enterprise_sso.pending";
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const TRUTHY = ["1", "true", "yes", "on"];

export interface PendingEnterpriseSso {
  state: string;
  /** Route to resume after sign-in; empty means an organic sign-in. */
  resume: string;
  startedAt: number;
}

export type EnterpriseSsoCallbackDecision =
  | { kind: "none" }
  | {
      kind: "failed";
      reason: "provider_error" | "missing_params" | "expired" | "state_mismatch";
      resume: string;
    }
  | { kind: "exchange"; code: string; state: string; resume: string };

/** Typed refusal from the SSO endpoints. `message` is a fixed, user-safe string. */
export class EnterpriseSsoRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EnterpriseSsoRequestError";
    this.code = code;
  }
}

/**
 * Whether the SSO entry point is offered. The backend `WORKOS_SSO_ENABLED`
 * flag stays the authority: every SSO route answers 404 while it is off. This
 * client flag only keeps a dead control off the sign-in screen. Unset means
 * off, so a build that never opted in never shows it.
 */
export function isEnterpriseSsoEnabled(): boolean {
  const raw = String(process.env.NEXT_PUBLIC_WORKOS_SSO_ENABLED || "")
    .trim()
    .toLowerCase();
  return TRUTHY.includes(raw);
}

export function looksLikeWorkEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function savePendingEnterpriseSso(pending: PendingEnterpriseSso): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(PENDING_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

/** Read and remove in one step: a pending attempt is single-use. */
export function takePendingEnterpriseSso(
  now: number = Date.now(),
): PendingEnterpriseSso | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(PENDING_KEY);
    store.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingEnterpriseSso>;
    if (
      typeof parsed.state !== "string" ||
      !parsed.state ||
      typeof parsed.startedAt !== "number" ||
      now - parsed.startedAt > PENDING_MAX_AGE_MS
    ) {
      return null;
    }
    return {
      state: parsed.state,
      resume: typeof parsed.resume === "string" ? parsed.resume : "",
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

/** A WorkOS redirect carries `state` plus either `code` or `error`. */
export function hasEnterpriseSsoCallbackParams(params: URLSearchParams): boolean {
  return Boolean(params.get("state")) && Boolean(params.get("code") || params.get("error"));
}

export function decideEnterpriseSsoCallback(
  params: URLSearchParams,
  pending: PendingEnterpriseSso | null,
): EnterpriseSsoCallbackDecision {
  if (!hasEnterpriseSsoCallbackParams(params)) return { kind: "none" };
  const resume = pending?.resume ?? "";
  if (params.get("error")) return { kind: "failed", reason: "provider_error", resume };
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  if (!code || !state) return { kind: "failed", reason: "missing_params", resume };
  if (!pending) return { kind: "failed", reason: "expired", resume };
  if (state !== pending.state) return { kind: "failed", reason: "state_mismatch", resume };
  return { kind: "exchange", code, state, resume };
}

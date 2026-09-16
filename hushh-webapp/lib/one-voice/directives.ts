"use client";

/**
 * Generic `ui_directive` execution for One Live Voice.
 *
 * The provider hands a directive to the screens first (useVoiceToolEffects);
 * what no screen claims lands here. This module owns the app-level kinds:
 * `navigate`, `focus_pending_action`, `open_share_sheet`, `refresh`. The two
 * Location-owned kinds, `publish_location_envelopes` and
 * `request_os_permission`, are deliberately NOT handled: the
 * LocationPublisherBridge owns them (it holds the setup-consent gate and the
 * publish loop), so they come back `handled:false` and the provider leaves
 * them to the screens.
 *
 * Every outcome is reported to the relay as `ui.settled` by the caller.
 */

import type { UiDirectiveKind } from "@/lib/one-voice/protocol";
import { requestProfilePaneOpen } from "@/lib/navigation/profile-pane";
import { ROUTES } from "@/lib/navigation/routes";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

export const ONE_VOICE_FOCUS_PENDING_EVENT = "one-voice:focus-pending" as const;
export const ONE_VOICE_REFRESH_EVENT = "one-voice:refresh" as const;

export type OneVoiceFocusPendingDetail = { pendingActionId: string | null };
export type OneVoiceRefreshDetail = { uiRefresh: string[] };

export type DirectiveSettleStatus = "opened" | "failed" | "ignored";

export type DirectiveOutcome = {
  /** False means "not mine": the caller should leave it to the screens. */
  handled: boolean;
  status: DirectiveSettleStatus;
  reason?: string;
};

/** Injection points so the provider and tests can run this without a browser. */
export type DirectiveHelpers = {
  /** The current app pathname (usePathname); decides pane-vs-route for Profile. */
  pathname: string | null;
  navigate?: (href: string) => boolean;
  openProfilePane?: () => void;
  share?: (data: {
    url?: string;
    text?: string;
    title?: string;
  }) => Promise<boolean>;
  copyText?: (text: string) => Promise<boolean>;
  notify?: (message: string) => void;
  dispatchEvent?: (event: Event) => void;
};

const SCREEN_OWNED_KINDS = new Set<string>([
  "publish_location_envelopes",
  "request_os_permission",
]);
const LOCATION_ROUTE_PREFIX = "/one/location";
const PRODUCT_ROUTE_PREFIX = "/one/";
const MAX_QUERY_ID_CHARS = 128;

/** Kinds the provider must not run itself; a Location screen owns them. */
export function isScreenOwnedDirective(kind: string): boolean {
  return SCREEN_OWNED_KINDS.has(kind);
}

function cleanString(value: unknown, max = 400): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function cleanId(value: unknown): string | null {
  const text = cleanString(value, MAX_QUERY_ID_CHARS);
  if (!text) return null;
  // Canonical ids only: no path or query syntax can ride along.
  return /^[A-Za-z0-9_.:@+-]+$/.test(text) ? text : null;
}

/** Internal product routes only; never a scheme, a host, or an escaped path. */
export function isSafeInternalHref(href: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  if (href.includes(":") || href.includes("\\") || /\s/.test(href))
    return false;
  return href.startsWith(PRODUCT_ROUTE_PREFIX) || href === "/one";
}

function isProductRoute(pathname: string | null): boolean {
  return Boolean(pathname && pathname.startsWith(PRODUCT_ROUTE_PREFIX));
}

function isLocationRoute(href: string): boolean {
  const path = href.split("?")[0] || "";
  return (
    path === LOCATION_ROUTE_PREFIX ||
    path.startsWith(`${LOCATION_ROUTE_PREFIX}/`)
  );
}

function withEntityQuery(
  href: string,
  payload: Record<string, unknown>,
): string {
  if (!isLocationRoute(href)) return href;
  const circleId = cleanId(payload.circle_id);
  const userId = cleanId(payload.user_id);
  if (!circleId && !userId) return href;
  const [path, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  if (circleId) params.set("circle", circleId);
  if (userId) params.set("person", userId);
  const search = params.toString();
  return search ? `${path}?${search}` : (path as string);
}

/**
 * Resolve a gateway action id to the href the app should open, or the Profile
 * pane. Returns null when the action is unknown, unwired, or not a route.
 */
export function resolveNavigateTarget(
  payload: Record<string, unknown>,
  pathname: string | null,
): { kind: "route"; href: string } | { kind: "profile_pane" } | null {
  const actionId = cleanString(payload.gateway_action_id, 120);
  if (!actionId) return null;
  const action = getKaiActionById(actionId);
  if (!action) return null;
  const target = action.execution_target;
  if (target.status !== "wired") return null;
  if (target.path === "route") {
    const href = cleanString(target.target, 400);
    if (!href || !isSafeInternalHref(href)) return null;
    return { kind: "route", href: withEntityQuery(href, payload) };
  }
  if (target.path === "kai_command" && target.target === "profile") {
    return isProductRoute(pathname)
      ? { kind: "profile_pane" }
      : { kind: "route", href: ROUTES.PROFILE };
  }
  return null;
}

/** The person dismissed the share sheet (a DOMException, not always an Error subclass). */
function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "AbortError",
  );
}

function defaultNavigate(href: string): boolean {
  return requestInternalAppNavigation({
    href,
    source: "voice",
    transitionMode: "contextual",
  });
}

async function defaultShare(data: {
  url?: string;
  text?: string;
  title?: string;
}): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function")
    return false;
  try {
    await navigator.share(data);
    return true;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return false;
  }
}

async function defaultCopyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText)
    return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function defaultNotify(message: string): void {
  // Lazy so this module stays importable in the reducer tests without sonner.
  void import("@/lib/morphy-ux/morphy").then(({ morphyToast }) =>
    morphyToast.success(message),
  );
}

function defaultDispatch(event: Event): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(event);
}

function outcome(
  status: DirectiveSettleStatus,
  reason?: string,
): DirectiveOutcome {
  return reason ? { handled: true, status, reason } : { handled: true, status };
}

/**
 * Run one generic directive. Never throws; the outcome is what the caller
 * reports as `ui.settled`. Screen-owned kinds return `handled:false`.
 */
export async function executeDirective(
  kind: UiDirectiveKind | string,
  payload: Record<string, unknown>,
  helpers: DirectiveHelpers,
): Promise<DirectiveOutcome> {
  const data = payload && typeof payload === "object" ? payload : {};
  if (isScreenOwnedDirective(kind)) {
    return { handled: false, status: "ignored", reason: "screen_owned" };
  }
  try {
    switch (kind) {
      case "navigate": {
        const target = resolveNavigateTarget(data, helpers.pathname);
        if (!target) return outcome("failed", "unknown_route");
        if (target.kind === "profile_pane") {
          (helpers.openProfilePane ?? (() => requestProfilePaneOpen("tap")))();
          return outcome("opened");
        }
        const navigated = (helpers.navigate ?? defaultNavigate)(target.href);
        return navigated
          ? outcome("opened")
          : outcome("failed", "navigation_unavailable");
      }
      case "focus_pending_action": {
        const detail: OneVoiceFocusPendingDetail = {
          pendingActionId: cleanId(data.pending_action_id),
        };
        (helpers.dispatchEvent ?? defaultDispatch)(
          new CustomEvent<OneVoiceFocusPendingDetail>(
            ONE_VOICE_FOCUS_PENDING_EVENT,
            { detail },
          ),
        );
        return outcome("opened");
      }
      case "refresh": {
        const raw = Array.isArray(data.ui_refresh) ? data.ui_refresh : [];
        const uiRefresh = raw
          .filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0,
          )
          .map((item) => item.trim().slice(0, 80))
          .slice(0, 20);
        (helpers.dispatchEvent ?? defaultDispatch)(
          new CustomEvent<OneVoiceRefreshDetail>(ONE_VOICE_REFRESH_EVENT, {
            detail: { uiRefresh },
          }),
        );
        return outcome("opened");
      }
      case "open_share_sheet": {
        const url = cleanString(data.url, 2_000);
        const text = cleanString(data.text, 1_000);
        const title = cleanString(data.title ?? data.circle_name, 200);
        if (!url && !text) return outcome("failed", "nothing_to_share");
        const share = helpers.share ?? defaultShare;
        try {
          const shared = await share({
            ...(url ? { url } : {}),
            ...(text ? { text } : {}),
            ...(title ? { title } : {}),
          });
          if (shared) return outcome("opened");
        } catch (error) {
          if (isAbortError(error)) return outcome("ignored", "dismissed");
        }
        const copied = await (helpers.copyText ?? defaultCopyText)(
          url ?? text ?? "",
        );
        if (!copied) return outcome("failed", "share_unavailable");
        (helpers.notify ?? defaultNotify)(url ? "Link copied" : "Copied");
        return outcome("opened", "copied");
      }
      default:
        return { handled: false, status: "ignored", reason: "unknown_kind" };
    }
  } catch (error) {
    return outcome("failed", error instanceof Error ? error.name : "error");
  }
}

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
import {
  decideProfileOpen,
  normalizePathname,
  type ProfileOpenDetail,
} from "@/lib/one-voice/profile-open";
import {
  buildProfilePaneHref,
  PROFILE_PANE_DETAIL_QUERY,
  PROFILE_PANE_PANEL_QUERY,
  PROFILE_PANE_QUERY,
  PROFILE_PANE_SHOWN_EVENT,
  profilePaneLocationKey,
  requestProfilePaneOpen,
  resolveProfilePaneUrlState,
  type ProfilePaneOpenResult,
} from "@/lib/navigation/profile-pane";
import { ROUTES, buildPersonProfileRoute } from "@/lib/navigation/routes";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

export const ONE_VOICE_FOCUS_PENDING_EVENT = "one-voice:focus-pending" as const;
export const ONE_VOICE_REFRESH_EVENT = "one-voice:refresh" as const;

export const ONE_VOICE_OPEN_MAIL_EVENT = "one-voice:open-mail" as const;
/**
 * How long a spoken open waits for the surface to actually show the message.
 *
 * The directive settles on the render, not on the dispatch: a handler that
 * returned is not evidence the person is looking at the message. Nothing
 * listening, or nothing rendered in this window, settles `failed` -- which is the
 * honest answer and lets One say so rather than assume.
 */
export const OPEN_MAIL_SETTLE_TIMEOUT_MS = 15_000;

export type OneVoiceOpenMailDetail = {
  ordinal: number;
  offerRevision: number;
  conversationId: string;
  /** Called by the surface once the message is shown, or once it cannot be. */
  settle: (status: "opened" | "failed", reason?: string) => void;
};

/**
 * A spoken "open the second one" against a drafts list. The same binding as a
 * mail open -- a position, its offer and its conversation -- on its own event, so
 * a mail list never answers a draft directive and a drafts list never answers a
 * mail one. Settles on the render, under the same timeout.
 */
export const ONE_VOICE_OPEN_DRAFT_EVENT = "one-voice:open-draft" as const;
export type OneVoiceOpenDraftDetail = OneVoiceOpenMailDetail;

/**
 * How long a spoken navigation waits for the screen to actually show.
 *
 * Like an open_mail, a navigate settles on the evidence, not the request: the
 * Profile pane can be refused by the shell (signed-out chrome, a full-screen
 * flow) and a route can be redirected away. Nothing observed in this window
 * settles `failed`, so One never says "opened" for a screen nobody sees. Kept
 * above a slow phone-network route fetch.
 */
export const NAVIGATE_SETTLE_TIMEOUT_MS = 10_000;
const NAVIGATE_POLL_MS = 100;

/** What counts as "shown" for a navigate: route state, or the Profile pane. */
export type NavigateObservation =
  | { kind: "path"; path: string; search?: string }
  | { kind: "profile_pane" }
  /**
   * A Profile screen below the root. On web, proxy.ts redirects
   * `/one/profile/<panel>/<detail>` into the pane on `/one` at that location;
   * a native build renders the path in place. Either counts as shown.
   */
  | { kind: "profile_route"; path: string; paneKey: string };

export type NavigateTarget =
  | {
      kind: "route";
      href: string;
      observe: NavigateObservation;
    }
  | { kind: "profile_pane" };

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
  /** The shell's synchronous answer; null means no shell listener answered. */
  openProfilePane?: () => ProfilePaneOpenResult | null;
  /**
   * Resolves true once the target is showing, false on timeout or abort.
   * Registered BEFORE the request is dispatched so a fast open is not missed.
   */
  observeNavigation?: (
    target: NavigateObservation,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<boolean>;
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
/** A server-confirmed public person ref is a UUID; nothing else fills /people. */
const PERSON_REF_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A route template segment such as `[personRef]`: never navigable literally. */
const ROUTE_TEMPLATE_SEGMENT = /\[[^\]]+\]/;

/**
 * The owner's Profile family. The root opens as the pane over the current
 * screen (like the chat avatar). Details use Profile routes; the legacy
 * Access route is resolved to its canonical pane URL below.
 */
const PROFILE_ACTION_DETAIL: Readonly<
  Record<string, ProfileOpenDetail | null>
> = {
  "route.profile": null,
  "route.profile_privacy": "access",
  "route.profile_access_panel": "access",
  "route.voice_settings": "preferences/voice",
};

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

/** A positive whole number inside a bound, or null. Never coerced from a string. */
function cleanCount(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= max
    ? value
    : null;
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

/** Where a Profile-family href shows: `/one/profile` redirects into the pane. */
function observationForHref(href: string): NavigateObservation {
  const path = normalizePathname(href);
  if (path === ROUTES.PROFILE) return { kind: "profile_pane" };
  if (path.startsWith(`${ROUTES.PROFILE}/`)) {
    return { kind: "profile_route", path, paneKey: profilePaneKeyForPath(path) };
  }
  const search = href.split("?")[1];
  return search ? { kind: "path", path, search: `?${search}` } : { kind: "path", path };
}

/** The pane location proxy.ts redirects `/one/profile/<panel>/<detail>` to. */
function profilePaneKeyForPath(path: string): string {
  const [panel = "", ...detail] = path
    .slice(ROUTES.PROFILE.length + 1)
    .split("/");
  const query = new URLSearchParams({
    [PROFILE_PANE_QUERY]: "1",
    [PROFILE_PANE_PANEL_QUERY]: panel,
  });
  if (detail.length) query.set(PROFILE_PANE_DETAIL_QUERY, detail.join("/"));
  return profilePaneLocationKey(resolveProfilePaneUrlState(query).location);
}

/** True when the address bar shows the pane open at that location. */
function paneShowsLocation(paneKey: string): boolean {
  const state = resolveProfilePaneUrlState(window.location.search);
  return state.open && profilePaneLocationKey(state.location) === paneKey;
}

/** Query-only Location moves must reach the requested view and entity. */
function pathShowsTarget(
  target: Extract<NavigateObservation, { kind: "path" }>,
  pathname: string,
  search: string,
): boolean {
  if (normalizePathname(pathname) !== target.path) return false;
  if (!target.search) return true;
  const actual = new URLSearchParams(search);
  for (const [key, value] of new URLSearchParams(target.search)) {
    if (actual.get(key) !== value) return false;
  }
  return true;
}

function resolveProfileTarget(
  detail: ProfileOpenDetail | null,
  pathname: string | null,
): NavigateTarget {
  const decision = decideProfileOpen({
    pathname: pathname ?? "",
    ...(detail ? { detail } : { presentation: "pane" as const }),
  });
  if (decision.kind === "pane") return { kind: "profile_pane" };
  if (detail === "access") {
    // /one/profile/access is a legacy route alias. The web proxy would turn
    // its path segment into profile_panel=access, which the pane normalizes to
    // its root. Address the actual Memory > Sharing location on both web and
    // native, preserving the same origin that decideProfileOpen supplied.
    const location = { panel: "my-data" as const, detail: "sharing" as const };
    const query = new URLSearchParams(decision.href.split("?")[1] ?? "");
    return {
      kind: "route",
      href: buildProfilePaneHref(ROUTES.ONE_HOME, query, location),
      observe: {
        kind: "profile_route",
        path: normalizePathname(decision.href),
        paneKey: profilePaneLocationKey(location),
      },
    };
  }
  return {
    kind: "route",
    href: decision.href,
    observe: observationForHref(decision.href),
  };
}

/**
 * Another person's profile. The ref comes only from the server-confirmed
 * directive payload and must be a UUID; anything else fails closed rather than
 * opening the owner's profile or a literal `/people/[personRef]`.
 */
function resolvePersonProfileTarget(
  payload: Record<string, unknown>,
  pathname: string | null,
): NavigateTarget | null {
  const ref = cleanString(payload.public_person_ref, 64);
  if (!ref || !PERSON_REF_PATTERN.test(ref)) return null;
  const href = buildPersonProfileRoute(ref, { from: pathname });
  return {
    kind: "route",
    href,
    observe: { kind: "path", path: normalizePathname(href) },
  };
}

/**
 * Resolve a gateway action id to the href the app should open, or the Profile
 * pane. Returns null when the action is unknown, unwired, or not a route.
 */
export function resolveNavigateTarget(
  payload: Record<string, unknown>,
  pathname: string | null,
): NavigateTarget | null {
  const actionId = cleanString(payload.gateway_action_id, 120);
  if (!actionId) return null;
  const action = getKaiActionById(actionId);
  if (!action) return null;
  const target = action.execution_target;
  if (target.status !== "wired") return null;
  if (Object.prototype.hasOwnProperty.call(PROFILE_ACTION_DETAIL, actionId)) {
    return resolveProfileTarget(
      PROFILE_ACTION_DETAIL[actionId] ?? null,
      pathname,
    );
  }
  if (target.path === "route" && target.target === ROUTES.PERSON_PROFILE) {
    return resolvePersonProfileTarget(payload, pathname);
  }
  if (target.path === "route") {
    const href = cleanString(target.target, 400);
    // A template segment needs an entity this branch cannot supply.
    if (!href || ROUTE_TEMPLATE_SEGMENT.test(href)) return null;
    if (!isSafeInternalHref(href)) return null;
    const routeHref = withEntityQuery(href, payload);
    return { kind: "route", href: routeHref, observe: observationForHref(routeHref) };
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
 * Resolve true when the target shows, false on timeout or abort. Every
 * listener, timer and interval is released on settle.
 */
export function defaultObserveNavigation(
  target: NavigateObservation,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (typeof window === "undefined" || signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const finish = (seen: boolean): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      if (poll !== null) clearInterval(poll);
      window.removeEventListener(PROFILE_PANE_SHOWN_EVENT, onShown);
      signal.removeEventListener("abort", onAbort);
      resolve(seen);
    };
    const onShown = (): void => {
      if (target.kind !== "profile_route" || paneShowsLocation(target.paneKey))
        finish(true);
    };
    const onAbort = (): void => finish(false);
    signal.addEventListener("abort", onAbort);
    timer = setTimeout(() => finish(false), timeoutMs);
    if (target.kind === "profile_pane") {
      window.addEventListener(PROFILE_PANE_SHOWN_EVENT, onShown);
      return;
    }
    if (target.kind === "profile_route") {
      // A fresh open mounts the pane body; an already-open pane only moves,
      // which the address bar shows.
      window.addEventListener(PROFILE_PANE_SHOWN_EVENT, onShown);
    }
    poll = setInterval(() => {
      if (
        (target.kind === "path"
          ? pathShowsTarget(target, window.location.pathname, window.location.search)
          : normalizePathname(window.location.pathname) === target.path) ||
        (target.kind === "profile_route" && paneShowsLocation(target.paneKey))
      ) {
        finish(true);
      }
    }, NAVIGATE_POLL_MS);
  });
}

/** Navigate to href and settle on the observation, never on the dispatch. */
async function settleRoute(
  href: string,
  observation: NavigateObservation,
  helpers: DirectiveHelpers,
  reason?: string,
): Promise<DirectiveOutcome> {
  if (
    observation.kind !== "profile_pane" &&
    normalizePathname(helpers.pathname ?? "") === observation.path &&
    (observation.kind !== "path" || !observation.search ||
      (typeof window !== "undefined" && pathShowsTarget(
        observation,
        window.location.pathname,
        window.location.search,
      )))
  ) {
    return outcome("opened", reason ?? "already_shown");
  }
  const controller = new AbortController();
  const seen = (helpers.observeNavigation ?? defaultObserveNavigation)(
    observation,
    NAVIGATE_SETTLE_TIMEOUT_MS,
    controller.signal,
  );
  const navigated = (helpers.navigate ?? defaultNavigate)(href);
  if (!navigated) {
    controller.abort();
    await seen;
    return outcome("failed", "navigation_unavailable");
  }
  return (await seen)
    ? outcome("opened", reason)
    : outcome("failed", "not_shown");
}

/**
 * Ask the shell for the Profile pane and settle on its answer plus the
 * pane-shown evidence. A refused pane falls back to the same action's
 * canonical route; the outcome reason says `pane_unavailable` (client side
 * only: ui.settled carries the status, not the reason).
 */
async function openProfilePaneVerified(
  helpers: DirectiveHelpers,
): Promise<DirectiveOutcome> {
  const controller = new AbortController();
  const seen = (helpers.observeNavigation ?? defaultObserveNavigation)(
    { kind: "profile_pane" },
    NAVIGATE_SETTLE_TIMEOUT_MS,
    controller.signal,
  );
  const result = (
    helpers.openProfilePane ?? (() => requestProfilePaneOpen("tap"))
  )();
  if (result === "opening") {
    return (await seen) ? outcome("opened") : outcome("failed", "not_shown");
  }
  controller.abort();
  await seen;
  if (result === "already_open") return outcome("opened", "already_open");
  // "unavailable", or no shell listener answered.
  return settleRoute(
    ROUTES.PROFILE,
    { kind: "profile_pane" },
    helpers,
    "pane_unavailable",
  );
}

/**
 * Ask the surface showing an offered list to open the row a directive names,
 * and settle on what the surface reports -- never on the dispatch.
 */
async function dispatchOpenRow(
  eventName: typeof ONE_VOICE_OPEN_MAIL_EVENT | typeof ONE_VOICE_OPEN_DRAFT_EVENT,
  data: Record<string, unknown>,
  helpers: DirectiveHelpers,
): Promise<DirectiveOutcome> {
  const ordinal = cleanCount(data.ordinal, 25);
  const offerRevision = cleanCount(data.offer_revision);
  const conversationId = cleanId(data.conversation_id);
  if (ordinal === null || offerRevision === null || !conversationId) {
    // An unbound reference would mean "whatever list is current", which is
    // the substitution the offer binding exists to prevent.
    return outcome("failed", "unbound_reference");
  }
  const detail: Omit<OneVoiceOpenMailDetail, "settle"> = {
    ordinal,
    offerRevision,
    conversationId,
  };
  return await new Promise<DirectiveOutcome>((resolve) => {
    let done = false;
    const finish = (status: "opened" | "failed", reason?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome(status, reason));
    };
    const timer = setTimeout(
      () => finish("failed", "not_shown"),
      OPEN_MAIL_SETTLE_TIMEOUT_MS,
    );
    (helpers.dispatchEvent ?? defaultDispatch)(
      new CustomEvent<OneVoiceOpenMailDetail>(eventName, {
        detail: { ...detail, settle: finish },
      }),
    );
  });
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
          return await openProfilePaneVerified(helpers);
        }
        return await settleRoute(target.href, target.observe, helpers);
      }
      case "open_mail":
        return await dispatchOpenRow(ONE_VOICE_OPEN_MAIL_EVENT, data, helpers);
      case "open_draft":
        return await dispatchOpenRow(ONE_VOICE_OPEN_DRAFT_EVENT, data, helpers);
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

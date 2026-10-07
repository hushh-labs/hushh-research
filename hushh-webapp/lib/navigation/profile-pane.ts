import type {
  LegalDocumentDetail,
  ProfileDetail,
  ProfilePanel,
} from "@/lib/navigation/profile-routes";
import {
  normalizeConnectorDetailId,
  normalizeProfileDetail,
  normalizeProfilePanel,
} from "@/lib/navigation/profile-routes";

export const PROFILE_PANE_OPEN_EVENT = "hushh:profile-pane-open";
// Presentation only: a preview neither admits Profile nor changes URL/focus.
export const PROFILE_PANE_PREVIEW_EVENT = "hushh:profile-pane-preview";
export type ProfilePanePreview = { phase: "drag" | "cancel" | "commit"; distance: number };
export function previewProfilePane(detail: ProfilePanePreview) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PROFILE_PANE_PREVIEW_EVENT, { detail }));
}
export const PROFILE_PANE_QUERY = "profile_pane";
export const PROFILE_PANE_PANEL_QUERY = "profile_panel";
export const PROFILE_PANE_DETAIL_QUERY = "profile_detail";

const PROFILE_PANE_HISTORY_KEY = "__hushhProfilePane";

export type ProfilePaneLocation = {
  panel: ProfilePanel | null;
  detail: ProfileDetail | null;
};

export type ProfilePaneUrlState = {
  open: boolean;
  location: ProfilePaneLocation;
};

export const PROFILE_PANE_ROOT_LOCATION: ProfilePaneLocation = {
  panel: null,
  detail: null,
};

function toSearchParams(
  value:
    | URLSearchParams
    | { get(name: string): string | null; toString?: () => string }
    | string
    | null
    | undefined,
): URLSearchParams {
  if (value instanceof URLSearchParams) return new URLSearchParams(value);
  if (typeof value === "string") return new URLSearchParams(value.replace(/^\?/, ""));
  if (!value) return new URLSearchParams();
  if (typeof value.toString === "function") {
    const serialized = value.toString();
    if (serialized && serialized !== "[object Object]") {
      return new URLSearchParams(serialized.replace(/^\?/, ""));
    }
  }
  const params = new URLSearchParams();
  for (const key of [
    PROFILE_PANE_QUERY,
    PROFILE_PANE_PANEL_QUERY,
    PROFILE_PANE_DETAIL_QUERY,
  ]) {
    const next = value.get(key);
    if (next !== null) params.set(key, next);
  }
  return params;
}

/**
 * The Connectors section inside Profile, optionally opened on one connector.
 * Every "open Connectors" entry (the Profile row, a Drive card's reconnect,
 * an OAuth return) resolves here so there is one destination, not one per
 * caller.
 */
export function profileConnectorsLocation(
  connectorId?: string | null,
): ProfilePaneLocation {
  const id = normalizeConnectorDetailId(connectorId ?? null);
  return { panel: "connectors", detail: id ? `connector:${id}` : null };
}

/**
 * An address that opens the Connectors section in the Profile pane over One.
 * For screens that are not already inside the app shell (an OAuth return
 * page); in-app callers open the pane over their own route instead.
 */
export function buildProfileConnectorsPaneHref(
  connectorId?: string | null,
): string {
  return profilePaneHref(
    "/one",
    null,
    profileConnectorsLocation(connectorId),
  );
}

/**
 * Where a connector sign-in lands once the provider sends the person back.
 * Both land on Connectors in the Profile pane, never on a page of its own: a
 * sign-in started in Profile reopens the pane over One, and one started in
 * chat reopens it over the chat (`/`), which restores its saved draft
 * underneath.
 */
export function buildConnectorSignInReturnHref(
  startedFrom: "connector_settings" | "chat",
): string {
  return profilePaneHref(
    startedFrom === "connector_settings" ? "/one" : "/",
    null,
    profileConnectorsLocation(),
  );
}

/**
 * A legal document read in place in Profile's Legal section. Profile never
 * leaves the pane for the public /terms or /privacy page: those addresses are
 * for people who are signed out, the store listings and Google's consent
 * screen.
 */
export function profileLegalLocation(
  document: LegalDocumentDetail,
): ProfilePaneLocation {
  return { panel: "legal", detail: document };
}

export function profilePaneLocationKey(location: ProfilePaneLocation): string {
  return `${location.panel ?? "root"}:${location.detail ?? "root"}`;
}

export function resolveProfilePaneUrlState(
  searchParams?:
    | URLSearchParams
    | { get(name: string): string | null; toString?: () => string }
    | string
    | null,
): ProfilePaneUrlState {
  const query = toSearchParams(searchParams);
  const open = query.get(PROFILE_PANE_QUERY) === "1";
  if (!open) return { open: false, location: PROFILE_PANE_ROOT_LOCATION };

  const panel = normalizeProfilePanel(query.get(PROFILE_PANE_PANEL_QUERY));
  return {
    open: true,
    location: {
      panel,
      detail: normalizeProfileDetail(
        panel,
        query.get(PROFILE_PANE_DETAIL_QUERY),
      ),
    },
  };
}

export function profilePaneParentLocation(
  location: ProfilePaneLocation,
): ProfilePaneLocation {
  return location.detail
    ? { panel: location.panel, detail: null }
    : PROFILE_PANE_ROOT_LOCATION;
}

function profilePaneHref(
  pathname: string,
  searchParams:
    | URLSearchParams
    | { get(name: string): string | null; toString?: () => string }
    | string
    | null
    | undefined,
  location: ProfilePaneLocation,
): string {
  const query = toSearchParams(searchParams);
  query.set(PROFILE_PANE_QUERY, "1");
  if (location.panel) query.set(PROFILE_PANE_PANEL_QUERY, location.panel);
  else query.delete(PROFILE_PANE_PANEL_QUERY);
  if (location.detail) query.set(PROFILE_PANE_DETAIL_QUERY, location.detail);
  else query.delete(PROFILE_PANE_DETAIL_QUERY);
  const encoded = query.toString();
  return encoded ? `${pathname}?${encoded}` : pathname;
}

export function buildProfilePaneHref(
  pathname: string,
  searchParams:
    | URLSearchParams
    | { get(name: string): string | null; toString?: () => string }
    | string
    | null
    | undefined,
  location: ProfilePaneLocation = PROFILE_PANE_ROOT_LOCATION,
): string {
  return profilePaneHref(pathname, searchParams, location);
}

/**
 * Where a legacy `/one/profile?...` address lands: the pane on `/one`, with
 * `panel|tab|profile_panel` and `detail|profile_detail` carried across. One
 * mapping for the server redirect on the web and the client redirect inside
 * the Capacitor bundle, which has no server to redirect from.
 */
export function legacyProfileRouteRedirectHref(
  query: Record<string, string | string[] | undefined> | URLSearchParams,
): string {
  const read = (key: string): string => {
    const raw =
      query instanceof URLSearchParams ? query.get(key) : query[key];
    return String(Array.isArray(raw) ? raw[0] ?? "" : raw ?? "").trim();
  };
  const params = new URLSearchParams();
  params.set(PROFILE_PANE_QUERY, "1");
  const panel = read("panel") || read("tab") || read(PROFILE_PANE_PANEL_QUERY);
  if (panel) params.set(PROFILE_PANE_PANEL_QUERY, panel);
  const detail = read("detail") || read(PROFILE_PANE_DETAIL_QUERY);
  if (detail) params.set(PROFILE_PANE_DETAIL_QUERY, detail);
  return `/one?${params.toString()}`;
}

export function buildProfilePaneCloseHref(
  pathname: string,
  searchParams:
    | URLSearchParams
    | { get(name: string): string | null; toString?: () => string }
    | string
    | null
    | undefined,
): string {
  const query = toSearchParams(searchParams);
  query.delete(PROFILE_PANE_QUERY);
  query.delete(PROFILE_PANE_PANEL_QUERY);
  query.delete(PROFILE_PANE_DETAIL_QUERY);
  const encoded = query.toString();
  return encoded ? `${pathname}?${encoded}` : pathname;
}

export function stripProfilePaneTransientParams(
  searchParams:
    | URLSearchParams
    | { get(name: string): string | null; toString?: () => string }
    | string
    | null
    | undefined,
): URLSearchParams {
  const query = toSearchParams(searchParams);
  query.delete("unlock_vault");
  query.delete("return_to");
  return query;
}

type ProfilePaneHistoryState = {
  depth?: number;
  /**
   * The pane was opened straight onto this location from a screen elsewhere
   * in the app (Puppy One's "Trusted devices" link, say). Back from that first
   * entry returns to the screen the person came from, not to the location's
   * static parent: they never saw the parent, so landing on it is a detour.
   */
  returnsToOrigin?: boolean;
};

function currentPaneHistoryState(): ProfilePaneHistoryState {
  if (typeof window === "undefined") return {};
  const state = window.history.state;
  if (!state || typeof state !== "object") return {};
  const paneState = (state as Record<string, unknown>)[PROFILE_PANE_HISTORY_KEY];
  if (!paneState || typeof paneState !== "object") return {};
  const depth = (paneState as Record<string, unknown>).depth;
  if (!(typeof depth === "number" && Number.isFinite(depth) && depth > 0)) {
    return {};
  }
  return (paneState as Record<string, unknown>).returnsToOrigin === true
    ? { depth, returnsToOrigin: true }
    : { depth };
}

function emitHistoryUpdate(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

export function getProfilePaneHistoryDepth(): number {
  return currentPaneHistoryState().depth ?? 0;
}

export function canGoBackProfilePane(location: ProfilePaneLocation): boolean {
  return Boolean(location.panel || location.detail);
}

export function pushProfilePaneLocation(
  pathname: string,
  searchParams:
    | URLSearchParams
    | { get(name: string): string | null; toString?: () => string }
    | string
    | null
    | undefined,
  location: ProfilePaneLocation,
  options: { returnsToOrigin?: boolean } = {},
): void {
  if (typeof window === "undefined") return;
  const depth = getProfilePaneHistoryDepth() + 1;
  const state =
    window.history.state && typeof window.history.state === "object"
      ? { ...(window.history.state as Record<string, unknown>) }
      : {};
  // Only the first pane entry can return to an origin; deeper entries are
  // ordinary steps inside the pane and pop with plain history.
  state[PROFILE_PANE_HISTORY_KEY] = (
    options.returnsToOrigin && depth === 1 ? { depth, returnsToOrigin: true } : { depth }
  ) satisfies ProfilePaneHistoryState;
  window.history.pushState(
    state,
    "",
    profilePaneHref(pathname, searchParams, location),
  );
  emitHistoryUpdate();
}

export function openProfilePane(
  pathname: string,
  searchParams:
    | URLSearchParams
    | { get(name: string): string | null; toString?: () => string }
    | string
    | null
    | undefined,
  location: ProfilePaneLocation = PROFILE_PANE_ROOT_LOCATION,
  options: {
    /**
     * Set by an in-app entry point that opens the pane directly on a panel or
     * detail. Back from that entry then returns to the calling screen instead
     * of the location's parent. Left unset by the shell's own resume, where a
     * restored child still steps back through its parent.
     */
    returnsToOrigin?: boolean;
  } = {},
): void {
  pushProfilePaneLocation(pathname, searchParams, location, options);
}

export function replaceProfilePaneLocation(
  pathname: string,
  searchParams:
    | URLSearchParams
    | { get(name: string): string | null; toString?: () => string }
    | string
    | null
    | undefined,
  location: ProfilePaneLocation,
): void {
  if (typeof window === "undefined") return;
  const state =
    window.history.state && typeof window.history.state === "object"
      ? { ...(window.history.state as Record<string, unknown>) }
      : {};
  // Replacing in place keeps the entry's origin: it is still the entry the
  // person arrived on.
  const paneState = currentPaneHistoryState();
  if (paneState.depth) {
    state[PROFILE_PANE_HISTORY_KEY] = paneState satisfies ProfilePaneHistoryState;
  }
  window.history.replaceState(
    state,
    "",
    profilePaneHref(pathname, searchParams, location),
  );
  emitHistoryUpdate();
}

export function popProfilePaneLocation(
  pathname: string,
  searchParams:
    | URLSearchParams
    | { get(name: string): string | null; toString?: () => string }
    | string
    | null
    | undefined,
): void {
  if (typeof window === "undefined") return;
  const current = resolveProfilePaneUrlState(searchParams);
  const paneState = currentPaneHistoryState();
  // Opened straight onto this location from another screen: Back returns
  // there. The previous history entry is that screen, so this closes the pane
  // on the same route it was opened over.
  if (paneState.returnsToOrigin && paneState.depth === 1) {
    window.history.back();
    return;
  }
  // A resumed or directly linked child may be the first pane entry. Browser
  // Back would leave the sheet, whereas its own Back must visit the parent.
  if (canGoBackProfilePane(current.location) && getProfilePaneHistoryDepth() <= 1) {
    replaceProfilePaneLocation(pathname, searchParams, profilePaneParentLocation(current.location));
    return;
  }
  if (getProfilePaneHistoryDepth() > 0) {
    window.history.back();
    return;
  }
  closeProfilePane(pathname, searchParams);
}

export function closeProfilePane(
  pathname: string,
  searchParams:
    | URLSearchParams
    | { get(name: string): string | null; toString?: () => string }
    | string
    | null
    | undefined,
): void {
  if (typeof window === "undefined") return;
  const depth = getProfilePaneHistoryDepth();
  if (depth > 0) {
    window.history.go(-depth);
    return;
  }
  const state =
    window.history.state && typeof window.history.state === "object"
      ? { ...(window.history.state as Record<string, unknown>) }
      : {};
  delete state[PROFILE_PANE_HISTORY_KEY];
  window.history.replaceState(
    state,
    "",
    buildProfilePaneCloseHref(pathname, searchParams),
  );
  emitHistoryUpdate();
}

/**
 * Remove transient pane state without traversing history. Authentication
 * changes must not send a signed-out person back through the signed-in stack.
 */
export function clearProfilePaneQuery(
  pathname: string,
  searchParams:
    | URLSearchParams
    | { get(name: string): string | null; toString?: () => string }
    | string
    | null
    | undefined,
): void {
  if (typeof window === "undefined") return;
  const state =
    window.history.state && typeof window.history.state === "object"
      ? { ...(window.history.state as Record<string, unknown>) }
      : {};
  delete state[PROFILE_PANE_HISTORY_KEY];
  window.history.replaceState(
    state,
    "",
    buildProfilePaneCloseHref(pathname, searchParams),
  );
  emitHistoryUpdate();
}

export type ProfilePaneOpenSource = "tap" | "native_swipe";

/**
 * Fired by the pane body once it has actually mounted for an open. A request
 * answered "opening" is only a request; this is the evidence it is showing.
 */
export const PROFILE_PANE_SHOWN_EVENT = "hushh:profile-pane-shown";

/** The shell's synchronous answer to an open request. */
export type ProfilePaneOpenResult = "opening" | "already_open" | "unavailable";

export type ProfilePaneOpenDetail = {
  source: ProfilePaneOpenSource;
  /** Transient authored opener, not inferred DOM or persisted state. */
  returnFocus?: HTMLElement;
  /** Called synchronously by the shell listener with what it did. */
  onResult?: (result: ProfilePaneOpenResult) => void;
};

/**
 * Ask the app shell to present Profile as a transient pane. The shell owns the
 * pane lifecycle so the top bar, native edge gesture, and future entry points
 * share one surface without adding another navigation stack.
 *
 * Returns the shell's answer, or null when no shell listener is mounted.
 * dispatchEvent is synchronous, so the listener has answered by return.
 */
export function requestProfilePaneOpen(
  source: ProfilePaneOpenSource = "tap",
  returnFocus?: HTMLElement,
): ProfilePaneOpenResult | null {
  if (typeof window === "undefined") return null;
  let result: ProfilePaneOpenResult | null = null;
  window.dispatchEvent(
    new CustomEvent<ProfilePaneOpenDetail>(PROFILE_PANE_OPEN_EVENT, {
      detail: {
        source,
        returnFocus,
        onResult: (value) => {
          result = value;
        },
      },
    }),
  );
  return result;
}

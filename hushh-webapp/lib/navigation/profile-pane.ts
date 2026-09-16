import type {
  ProfileDetail,
  ProfilePanel,
} from "@/lib/navigation/profile-routes";
import { normalizeProfileDetail, normalizeProfilePanel } from "@/lib/navigation/profile-routes";

export const PROFILE_PANE_OPEN_EVENT = "hushh:profile-pane-open";
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
};

function currentPaneHistoryState(): ProfilePaneHistoryState {
  if (typeof window === "undefined") return {};
  const state = window.history.state;
  if (!state || typeof state !== "object") return {};
  const paneState = (state as Record<string, unknown>)[PROFILE_PANE_HISTORY_KEY];
  if (!paneState || typeof paneState !== "object") return {};
  const depth = (paneState as Record<string, unknown>).depth;
  return typeof depth === "number" && Number.isFinite(depth) && depth > 0
    ? { depth }
    : {};
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
): void {
  if (typeof window === "undefined") return;
  const depth = getProfilePaneHistoryDepth() + 1;
  const state =
    window.history.state && typeof window.history.state === "object"
      ? { ...(window.history.state as Record<string, unknown>) }
      : {};
  state[PROFILE_PANE_HISTORY_KEY] = { depth } satisfies ProfilePaneHistoryState;
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
): void {
  pushProfilePaneLocation(pathname, searchParams, location);
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
  const depth = getProfilePaneHistoryDepth();
  if (depth > 0) {
    state[PROFILE_PANE_HISTORY_KEY] = { depth } satisfies ProfilePaneHistoryState;
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

export type ProfilePaneOpenDetail = {
  source: ProfilePaneOpenSource;
};

/**
 * Ask the app shell to present Profile as a transient pane. The shell owns the
 * pane lifecycle so the top bar, native edge gesture, and future entry points
 * share one surface without adding another navigation stack.
 */
export function requestProfilePaneOpen(
  source: ProfilePaneOpenSource = "tap",
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ProfilePaneOpenDetail>(PROFILE_PANE_OPEN_EVENT, {
      detail: { source },
    }),
  );
}

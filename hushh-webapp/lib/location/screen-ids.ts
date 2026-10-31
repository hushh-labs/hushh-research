/**
 * URL grammar for the voice-first Location area.
 *
 * `/one/location?view=<tab>` names one of the hub tabs; `?action=<flow>` opens
 * a task flow inside the shell; `?circle=<id>` and `?person=<user_id>` focus
 * an entity. The backend `open_screen` tool names screens by the ids in
 * `LOCATION_SCREEN_IDS`; `hrefForLocationScreen` is the single place that
 * turns one of those ids into an href, so the relay, the breadcrumb resolver
 * and the router all agree on the same destinations.
 */

import { ROUTES } from "@/lib/navigation/routes";

export const LOCATION_VIEWS = ["now", "people", "circles", "links"] as const;
export type LocationView = (typeof LOCATION_VIEWS)[number];
export const DEFAULT_LOCATION_VIEW: LocationView = "now";

export const LOCATION_ACTIONS = [
  "share",
  "ask",
  "invite-circle",
  "create-circle",
  "join-circle",
  "circle-detail",
  "check-in",
  "sos",
  "sms-contacts",
  "settings",
  "active-shares",
  "shared-with-me",
  "needs-review",
  "ratings",
] as const;
export type LocationAction = (typeof LOCATION_ACTIONS)[number];

/**
 * Older links that still arrive at the hub. Each resolves to the action the
 * voice-first area actually renders, so a stale deep link lands on a screen
 * instead of the "no longer there" toast.
 */
export const LEGACY_LOCATION_ACTION_ALIASES: Readonly<
  Record<string, LocationAction>
> = {
  invite: "invite-circle",
  privacy: "settings",
};

/** Screen ids from the backend `open_screen` tool (one-voice-live-tools.v1). */
export const LOCATION_SCREEN_IDS = [
  "location_home",
  "location_people",
  "location_links",
  "location_circles",
  "location_share",
  "location_ask",
  "location_invite",
  "location_create_circle",
  "location_join_circle",
  "location_check_in",
  "location_sos",
  "location_emergency_contacts",
  "location_settings",
  "location_active_shares",
  "location_shared_with_me",
  "location_needs_review",
  "location_map",
  "location_ratings",
  "location_setup",
] as const;
export type LocationScreenId = (typeof LOCATION_SCREEN_IDS)[number];

/** Stable `app_context.screen` ids each screen publishes through voice metadata. */
export const LOCATION_VOICE_SCREEN_IDS = {
  home: "one_location",
  people: "one_location_people",
  settings: "one_location_settings",
  ask: "one_location_ask",
  share: "one_location_share",
} as const;

export function isLocationView(
  value: string | null | undefined,
): value is LocationView {
  return (
    typeof value === "string" &&
    (LOCATION_VIEWS as readonly string[]).includes(value)
  );
}

export function isLocationAction(
  value: string | null | undefined,
): value is LocationAction {
  return (
    typeof value === "string" &&
    (LOCATION_ACTIONS as readonly string[]).includes(value)
  );
}

export function isLocationScreenId(
  value: string | null | undefined,
): value is LocationScreenId {
  return (
    typeof value === "string" &&
    (LOCATION_SCREEN_IDS as readonly string[]).includes(value)
  );
}

/** The action a raw `?action=` value renders, after legacy aliases. */
export function resolveLocationAction(
  raw: string | null | undefined,
): LocationAction | null {
  if (!raw) return null;
  if (isLocationAction(raw)) return raw;
  return LEGACY_LOCATION_ACTION_ALIASES[raw] ?? null;
}

export type LocationScreenHrefOptions = {
  circleId?: string | null;
  userId?: string | null;
};

function withParams(
  base: string,
  params: Array<[key: string, value: string | null | undefined]>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of params) {
    const clean = typeof value === "string" ? value.trim() : "";
    if (clean) search.set(key, clean);
  }
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}

export function hrefForLocationView(view: LocationView): string {
  return withParams(ROUTES.ONE_LOCATION, [["view", view]]);
}

export function hrefForLocationAction(
  action: LocationAction,
  options: LocationScreenHrefOptions = {},
): string {
  return withParams(ROUTES.ONE_LOCATION, [
    ["action", action],
    ["circle", options.circleId],
    ["person", options.userId],
  ]);
}

/**
 * Map a backend `open_screen` id to the href the app renders it at.
 *
 * Returns null for ids the Location area does not own (profile screens,
 * Connect) so the caller can fall through to the general route table
 * instead of landing on the hub by accident.
 */
export function hrefForLocationScreen(
  screen: string,
  options: LocationScreenHrefOptions = {},
): string | null {
  switch (screen) {
    case "location_home":
      return hrefForLocationView("now");
    case "location_people":
      return withParams(ROUTES.ONE_LOCATION, [
        ["view", "people"],
        ["person", options.userId],
      ]);
    case "location_links":
      return hrefForLocationView("links");
    case "location_circles":
      return withParams(ROUTES.ONE_LOCATION, [
        ["view", "circles"],
        ["circle", options.circleId],
      ]);
    case "location_share":
      return hrefForLocationAction("share", { userId: options.userId });
    case "location_ask":
      return hrefForLocationAction("ask", { userId: options.userId });
    case "location_invite":
      return hrefForLocationAction("invite-circle", {
        circleId: options.circleId,
        userId: options.userId,
      });
    case "location_create_circle":
      return hrefForLocationAction("create-circle");
    case "location_join_circle":
      return hrefForLocationAction("join-circle");
    case "location_check_in":
      return hrefForLocationAction("check-in", { userId: options.userId });
    case "location_sos":
      return hrefForLocationAction("sos");
    case "location_emergency_contacts":
      return hrefForLocationAction("sms-contacts");
    case "location_settings":
      return hrefForLocationAction("settings");
    case "location_active_shares":
      return hrefForLocationAction("active-shares");
    case "location_shared_with_me":
      return hrefForLocationAction("shared-with-me");
    case "location_needs_review":
      return hrefForLocationAction("needs-review");
    case "location_map":
      return ROUTES.ONE_LOCATION_MAP;
    case "location_ratings":
      return hrefForLocationAction("ratings");
    case "location_setup":
      return ROUTES.ONE_SETUP_LOCATION;
    default:
      return null;
  }
}

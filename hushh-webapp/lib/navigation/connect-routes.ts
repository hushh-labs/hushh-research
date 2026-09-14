import { ROUTES } from "@/lib/navigation/routes";
import { appRouteMatches } from "@/lib/navigation/route-settlement";

export const CONNECT_SURFACE_PARAM = "tab";
export const CONNECT_SEARCH_QUERY_PARAM = "q";
/** Exact directory person; opens the owning scope review, never sends a request. */
export const CONNECT_REVIEW_PERSON_PARAM = "reviewPerson";
export const connectPersonReviewHref = (personId: string) => `${ROUTES.CONNECT}?${new URLSearchParams({[CONNECT_REVIEW_PERSON_PARAM]:personId})}`;

/** Connect may discover an incoming request while opening a person's review.
 * Its authored Consent Center redirect retains the exact source as `from`.
 * This proves a screen handoff only; it never grants connection authority. */
export function connectReviewRedirectMatches(current: string, expected: string): boolean {
  try {
    const target = new URL(expected, "https://app.invalid");
    const actual = new URL(current, "https://app.invalid");
    const source = actual.searchParams.get("from");
    return actual.origin === target.origin &&
      appRouteMatches(target.pathname, ROUTES.CONNECT) &&
      Boolean(target.searchParams.get(CONNECT_REVIEW_PERSON_PARAM)) &&
      appRouteMatches(actual.pathname, ROUTES.CONSENTS) &&
      actual.searchParams.get("tab") === "pending" &&
      Boolean(actual.searchParams.get("requestId")) &&
      Boolean(source && appRouteMatches(source, expected, true));
  } catch { return false; }
}
export const CONNECT_CIRCLE_ACTION_PARAM = "action";
export const CONNECT_CIRCLE_ID_PARAM = "circleId";
export const CONNECT_CIRCLES_LIST_HREF = `${ROUTES.CONNECT}?tab=circles`;

export type ConnectSurface = "all" | "circles";
export type ConnectCircleAction =
  | "create-circle"
  | "join-circle"
  | "circle-detail";
export type FocusedConnectCircleAction =
  | "create-circle"
  | "join-circle"
  | "circle-detail";
export function readConnectSurface(value: string | null): ConnectSurface {
  return value === "circles" ? "circles" : "all";
}

export function readConnectCircleAction(
  value: string | null,
): ConnectCircleAction | null {
  return value === "create-circle" ||
    value === "join-circle" ||
    value === "circle-detail"
    ? value
    : null;
}

export function isFocusedConnectCircleTask(
  surface: string | null | undefined,
  action: string | null | undefined,
  circleId?: string | null,
): action is FocusedConnectCircleAction {
  return (
    surface === "circles" &&
    (action === "create-circle" ||
      action === "join-circle" ||
      (action === "circle-detail" && Boolean(circleId?.trim())))  );
}

export function connectCircleTaskTitle(
  action: ConnectCircleAction | null,
): string | null {
  if (action === "create-circle") return "Create a Circle";
  if (action === "join-circle") return "Join a Circle";
  if (action === "circle-detail") return "Circle";
  return null;
}

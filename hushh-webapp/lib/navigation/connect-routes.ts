import { ROUTES } from "@/lib/navigation/routes";

export const CONNECT_SURFACE_PARAM = "tab";
export const CONNECT_SEARCH_QUERY_PARAM = "q";
export const CONNECT_CIRCLE_ACTION_PARAM = "action";
export const CONNECT_CIRCLE_ID_PARAM = "circleId";
export const CONNECT_CIRCLES_LIST_HREF = `${ROUTES.CONNECT}?tab=circles`;

export type ConnectSurface = "all" | "circles";
export type ConnectCircleAction =
  | "create-circle"
  | "join-circle"
  | "circle-detail";
export type FocusedConnectCircleAction = "create-circle" | "join-circle";

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
): action is FocusedConnectCircleAction {
  return (
    surface === "circles" &&
    (action === "create-circle" || action === "join-circle")
  );
}

export function connectCircleTaskTitle(
  action: ConnectCircleAction | null,
): string | null {
  if (action === "create-circle") return "Create a Circle";
  if (action === "join-circle") return "Join a Circle";
  if (action === "circle-detail") return "Circle";
  return null;
}

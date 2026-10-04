import { ROUTES } from "@/lib/navigation/routes";
import { CONNECT_CIRCLE_ACTION_PARAM, CONNECT_CIRCLE_ID_PARAM, CONNECT_SURFACE_PARAM } from "@/lib/navigation/connect-routes";
const CIRCLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function circleChatHref(circleId: string): string | null {
  if (!CIRCLE_ID.test(circleId)) return null;
  const params = new URLSearchParams({ [CONNECT_SURFACE_PARAM]: "circles",
    [CONNECT_CIRCLE_ACTION_PARAM]: "circle-detail", [CONNECT_CIRCLE_ID_PARAM]: circleId, circleChat: "1" });
  return `${ROUTES.CONNECT}?${params}`;
}
export function circleChatNotificationTarget(data?: Record<string, unknown>): string | null {
  if (data?.type !== "location_circle_message") return null;
  return circleChatHref(String(data.circle_id ?? "")) ?? ROUTES.ONE_FEED;
}

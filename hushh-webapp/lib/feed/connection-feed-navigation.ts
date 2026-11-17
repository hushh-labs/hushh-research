import { ROUTES } from "@/lib/navigation/routes";

export function directMessageFeedHref(metadata: Record<string, unknown>): string {
  const token = typeof metadata.direct_message_route_token === "string" ? metadata.direct_message_route_token.trim() : "";
  if (token.startsWith("dm1.")) return `${ROUTES.ONE_MESSAGES}?token=${encodeURIComponent(token)}`;
  const id = typeof metadata.direct_message_conversation_id === "string" ? metadata.direct_message_conversation_id.trim() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? `${ROUTES.ONE_MESSAGES}?conversation=${encodeURIComponent(id)}` : ROUTES.ONE_MESSAGES;
}

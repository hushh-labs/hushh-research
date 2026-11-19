import type { FeedItem } from "@/lib/services/feed-service";

export type FeedMailSelection = { kind: "request" | "message"; id: string };
/** Only source-verified identifiers projected by the owner-scoped Feed API. */
export function feedMailSelection(item: FeedItem): FeedMailSelection | null {
  if (!["mail_message_sent", "mail_message_failed", "mail_delivery_unconfirmed"].includes(item.event_type)) return null;
  const workflow = item.metadata.workflow_id;
  if (typeof workflow === "string" && /^[a-f0-9-]{36}$/i.test(workflow)) return { kind: "request", id: workflow };
  const action = item.metadata.send_action_id;
  if (typeof action === "string" && /^(?:[A-Za-z0-9-]{1,128}|gmod_[A-Za-z0-9_-]{16,64})$/.test(action)) return { kind: "message", id: action };
  return null;
}

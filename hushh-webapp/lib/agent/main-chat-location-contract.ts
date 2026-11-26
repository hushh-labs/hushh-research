import { splitSpokenNames } from "@/lib/one-location/resolve-spoken-names";

export const MAIN_CHAT_LOCATION_ENABLED = process.env.NEXT_PUBLIC_ONE_MAIN_CHAT_LOCATION_ENABLED === "true";

export const locationRecoveryActions = ["setup_location", "enable_location", "enable_device_location", "resume_updates"] as const;
export const locationSafetyActions = ["sos_review", "sos_stop", "sms_contacts"] as const;
export const locationWorkspaceActions = ["manage_circles", "manage_places", "manage_ratings", "manage_contacts", "manage_settings", "manage_links", "check_in", "nearby_check_in", "view_self"] as const;
export type LocationRecoveryAction = typeof locationRecoveryActions[number];
export type LocationSafetyAction = typeof locationSafetyActions[number];
export type LocationWorkspaceAction = typeof locationWorkspaceActions[number];

const actions = [
  "share_options", "share_private", "share_public",
  "share_live", "share_pin", "ask", "view", "list_shares", "list_requests", "stop", "set_duration",
  "extend", "ask_extension", "approve", "decline",
  ...locationRecoveryActions, ...locationSafetyActions, ...locationWorkspaceActions,
] as const;
export type MainLocationAction = typeof actions[number];
export type MainLocationProposal = {
  id: string;
  attemptId?: string;
  action: MainLocationAction;
  people?: string[];
  circles?: string[];
  durationHours?: number;
  durationMode?: "timed" | "until_stopped";
  direction?: "incoming" | "outgoing" | "all";
};
export type MainLocationContinuation = {
  step: "visibility" | "audience" | "duration" | "review" | "receipt";
  action: MainLocationAction;
  people: string[];
  circles: string[];
  durationHours?: number;
};

// Earlier private-pod images can still return the authored route action.
// These navigation actions declare no slots. The review resolves any missing
// audience from the owner's current Location information.
const legacyLocationNavigation = new Map<string, Omit<MainLocationProposal, "id">>([
  ["location.open_share", { action: "share_options" }],
  ["location.open_ask", { action: "ask" }],
  ["location.open_sos", { action: "sos_review" }],
  ["location.open_sms_contacts", { action: "sms_contacts" }],
  ["location.open_settings", { action: "manage_settings" }],
  ["location.review_notifications", { action: "manage_settings" }],
  ["location.open_ratings", { action: "manage_ratings" }],
  ["location.open_invite", { action: "manage_contacts" }],
  ["location.add_connections", { action: "manage_contacts" }],
  ["location.open_circles", { action: "manage_circles" }],
  ["location.open_create_circle", { action: "manage_circles" }],
  ["location.open_join_circle", { action: "manage_circles" }],
  ["location.open_temporary_link", { action: "share_public" }],
  ["location.open_links", { action: "manage_links" }],
  ["location.open_check_in", { action: "check_in" }],
  ["location.open_shared_with_me", { action: "list_shares", direction: "incoming" }],
  ["location.open_active_shares", { action: "list_shares", direction: "outgoing" }],
  ["location.open_needs_review", { action: "list_requests", direction: "incoming" }],
  ["location.open_map", { action: "list_shares", direction: "incoming" }],
  ["location.setup.start", { action: "setup_location" }],
]);

const legacyLocationLocalReview = new Map<string, MainLocationAction>([
  ["location.select_share_recipient", "share_private"],
  ["location.select_ask_recipient", "ask"],
  ["location.share_selected", "share_live"],
  ["location.send_request", "ask"],
  ["location.create_public_link", "share_public"],
  ["location.stop_share", "stop"],
  ["location.change_share_duration", "set_duration"],
  ["location.approve_request", "approve"],
  ["location.decline_request", "decline"],
  ["location.refresh", "list_shares"],
  ["location.pause_updates", "manage_settings"],
  ["location.resume_updates", "resume_updates"],
  ["location.set_auto_share", "manage_settings"],
  ["location.set_ghost_mode", "manage_settings"],
  ["location.create_circle", "manage_circles"],
  ["location.add_to_circle", "manage_circles"],
  ["location.remove_from_circle", "manage_circles"],
  ["location.rename_circle", "manage_circles"],
  ["location.leave_circle", "manage_circles"],
  ["location.delete_circle", "manage_circles"],
  ["location.accept_circle_invite", "manage_circles"],
  ["location.decline_circle_invite", "manage_circles"],
  ["location.save_current_location", "manage_places"],
  ["location.delete_saved_location", "manage_places"],
  ["location.send_check_in", "check_in"],
  ["location.nearby_check_in", "nearby_check_in"],
  ["location.confirm_nearby_check_in", "nearby_check_in"],
  ["location.checkout_nearby", "nearby_check_in"],
  ["location.share_public_link", "manage_links"],
  ["location.revoke_public_link", "manage_links"],
  ["location.trigger_sos", "sos_review"],
  ["location.sos_default", "sos_review"],
  ["location.stop_sos", "sos_stop"],
  ["location.add_emergency_contact", "sms_contacts"],
  ["location.remove_emergency_contact", "sms_contacts"],
]);

const legacyPersonHints = new Set<MainLocationAction>([
  "ask", "share_private", "share_live", "stop", "set_duration", "approve", "decline", "manage_circles",
]);

function locationNameHint(value: unknown) {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name && name.length <= 120 && !UUID.test(name) && !/[\p{Cc}\p{Cs}]/u.test(name) ? name : undefined;
}

export function locationReviewForLegacyAction(actionId: string, path: string, slots: Record<string, unknown> = {}) {
  if (path === "route") {
    const draft = legacyLocationNavigation.get(actionId);
    return draft ? { draft, selectionOnly: false } : null;
  }
  if (path !== "local_handler") return null;
  const action = legacyLocationLocalReview.get(actionId);
  if (!action) return null;
  const draft: Omit<MainLocationProposal, "id"> = { action };
  if (legacyPersonHints.has(action) && typeof slots.person === "string") {
    const names = (action === "set_duration" ? [slots.person] : splitSpokenNames(slots.person)).map(locationNameHint);
    if (names.length <= 20 && names.every((name) => name !== undefined)) draft.people = names;
  }
  if (action === "share_private" || action === "share_live" || action === "ask" || action === "manage_circles") {
    const circle = locationNameHint(actionId === "location.create_circle" ? slots.name : slots.circle);
    if (circle) draft.circles = [circle];
  }
  if (action === "share_live" || action === "share_public" || action === "ask" || action === "set_duration") {
    const raw = slots.duration_hours;
    const hours = typeof raw === "number" || (typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw.trim())) ? Number(raw) : 0;
    if (hours >= 0.25 && hours <= (action === "share_public" ? 2 : 24)) draft.durationHours = hours;
    if (raw === "until_stopped" && (action === "share_live" || action === "set_duration")) draft.durationMode = raw;
  }
  return { draft, selectionOnly: actionId === "location.select_share_recipient" || actionId === "location.select_ask_recipient" };
}

export function locationReviewActionForLegacyDirective(event: {
  delegateAgentId: string;
  directive: { kind: string; payload: { type?: unknown } };
}): "sos_review" | "enable_device_location" | null {
  if (event.delegateAgentId !== "agent_location" || event.directive.kind !== "action") return null;
  switch (event.directive.payload.type) {
    case "sos_panic": return "sos_review";
    case "request_device_location_permission": return "enable_device_location";
    default: return null;
  }
}

const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

export function parseMainLocationProposal(value: unknown): MainLocationProposal | null {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.proposal && typeof input.proposal === "object") return parseMainLocationProposal(input.proposal);
  if (input.type !== "location.chat_action" || typeof input.id !== "string" ||
      !UUID.test(input.id) || !actions.some((action) => action === input.action)) return null;
  const names = (items: unknown, limit: number) => {
    if (items === undefined || items === null) return undefined;
    if (!Array.isArray(items) || items.length > limit ||
        items.some((name) => typeof name !== "string" || !name.trim() || name.length > 160)) return null;
    return [...new Set((items as string[]).map((name) => name.trim()))];
  };
  const people = names(input.people, 20);
  const circles = names(input.circles, 5);
  if (people === null || circles === null) return null;
  const action = input.action as MainLocationAction;
  const dedicatedReview = [...locationRecoveryActions, ...locationSafetyActions, "manage_places", "manage_ratings", "manage_contacts", "manage_settings", "manage_links", "nearby_check_in", "view_self"]
    .some((entry) => entry === action);
  if (dedicatedReview && (people?.length || circles?.length || input.durationHours != null ||
      input.durationMode != null || input.direction != null)) return null;
  return {
    id: input.id, action, people, circles,
    ...(typeof input.durationHours === "number" && Number.isFinite(input.durationHours) && input.durationHours > 0
      ? { durationHours: input.durationHours } : {}),
    ...(input.durationMode === "timed" || input.durationMode === "until_stopped" ? { durationMode: input.durationMode } : {}),
    ...(input.direction === "incoming" || input.direction === "outgoing" || input.direction === "all" ? { direction: input.direction } : {}),
  };
}

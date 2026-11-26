import { isSharedDevIosSimulator } from "@/lib/app-env";

export const MAIN_CHAT_LOCATION_ENABLED = process.env.NEXT_PUBLIC_ONE_MAIN_CHAT_LOCATION_ENABLED === "true" || isSharedDevIosSimulator();

const actions = [
  "share_options", "share_private", "share_public",
  "share_live", "share_pin", "ask", "view", "list_shares", "list_requests", "stop", "set_duration",
  "extend", "ask_extension", "approve", "decline",
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
  return {
    id: input.id, action: input.action as MainLocationAction, people, circles,
    ...(typeof input.durationHours === "number" && Number.isFinite(input.durationHours) && input.durationHours > 0
      ? { durationHours: input.durationHours } : {}),
    ...(input.durationMode === "timed" || input.durationMode === "until_stopped" ? { durationMode: input.durationMode } : {}),
    ...(input.direction === "incoming" || input.direction === "outgoing" || input.direction === "all" ? { direction: input.direction } : {}),
  };
}

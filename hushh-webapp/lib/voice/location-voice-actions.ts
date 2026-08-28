import { listKaiActionsForSurface } from "@/lib/voice/kai-action-gateway";
import type { VoiceSurfaceActionDefinition } from "@/lib/voice/voice-types";

// Wired in the generated gateway but with no real handler anywhere in the
// runtime -- publishing one would offer a voice command guaranteed to fail.
// Shared across every Location screen id (one_location, one_location_map,
// one_location_check_in): these are the same underlying actions on each
// screen, not per-screen exceptions, so the exclusion has to live in one
// place or a new publishing site can silently reintroduce it.
//
// location.checkout_nearby used to be here -- it now has a real handler in
// nearby-check-in-sheet.tsx, so it was removed. Left empty rather than
// deleted so the next genuinely handlerless action has an obvious home.
export const LOCATION_VOICE_ACTIONS_EXCLUDE_IDS = new Set<string>([]);

// Derives what a Location screen should publish directly from the generated
// action gateway, so a new action becomes voice-reachable the moment it is
// added to the contract instead of needing a second, hand-maintained list
// per screen to remember to update.
export function deriveLocationVoiceActions(
  screen: string,
): VoiceSurfaceActionDefinition[] {
  return listKaiActionsForSurface({ screen })
    .filter(
      (action) =>
        action.execution_target.status === "wired" &&
        (action.execution_target.path === "local_handler" ||
          action.execution_target.path === "route") &&
        action.execution_policy !== "manual_only" &&
        !LOCATION_VOICE_ACTIONS_EXCLUDE_IDS.has(action.action_id),
    )
    .map((action) => ({
      id: action.action_id,
      actionId: action.action_id,
      label: action.label,
      // First sentence only: the contract's `meaning` is full multi-sentence
      // prose written for the model's semantic assessment, not a short
      // one-liner. This field is consumed as a terse purpose string elsewhere
      // in this surface's metadata, matching the previous hand-written style.
      purpose: action.meaning.split(/(?<=[.!?])\s/)[0] || action.meaning,
    }));
}

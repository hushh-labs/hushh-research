import { listKaiActionsForSurface } from "@/lib/voice/kai-action-gateway";
import type { VoiceSurfaceActionDefinition } from "@/lib/voice/voice-types";

// Wired in the generated gateway but with no way to actually run -- publishing
// one would offer a voice command guaranteed to fail. Shared across every
// Location screen id (one_location, one_location_map, one_location_check_in):
// these are the same underlying actions on each screen, not per-screen
// exceptions, so the exclusion has to live in one place or a new publishing
// site can silently reintroduce it.
//
// Empty, and worth keeping that way. Before adding an id here, check whether
// the action is in BACKEND_DIRECT_ACTION_IDS (consent-protocol's
// action_tools.py) -- those execute server-side and need no frontend handler
// at all, so a missing local handler is not evidence that an action is
// broken. location.checkout_nearby was excluded on exactly that mistaken
// reading.
export const LOCATION_VOICE_ACTIONS_EXCLUDE_IDS = new Set<string>([]);

// The execution paths a Location screen can offer. `control` belongs here
// alongside the other two: agent-action-runtime.ts dispatches it through the
// same resolveLocalOnboardingHandler registry as `local_handler` (it falls
// through to it for any path that isn't `route`), so a control-path action
// with a registered handler runs exactly like a local one. Leaving it out
// silently dropped location.find_contacts from every Location screen even
// after it was wired, given a handler, and made visible in the gateway.
const PUBLISHABLE_EXECUTION_PATHS = new Set(["local_handler", "route", "control"]);

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
        PUBLISHABLE_EXECUTION_PATHS.has(action.execution_target.path) &&
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

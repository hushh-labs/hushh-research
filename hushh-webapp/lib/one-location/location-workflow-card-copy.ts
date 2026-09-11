import type { LocationServerDirectiveContract } from "@/lib/services/one-location-onboarding-run-client";

type ResultContract = LocationServerDirectiveContract["results"][number];
export type LocationWorkflowCardCopyKey =
  | LocationServerDirectiveContract["titleKey"]
  | LocationServerDirectiveContract["bodyKey"]
  | ResultContract["labelKey"];

/** English catalog values for compiler-issued keys. No server prose is rendered. */
const COPY: Record<LocationWorkflowCardCopyKey, string> = {
  "one.location.already_complete.title": "Location is already set up",
  "one.location.already_complete.body":
    "Your verified Location setup is ready to use.",
  "one.location.awaiting_vault_finalize.title": "Ready for private vault setup",
  "one.location.awaiting_vault_finalize.body":
    "Your encrypted on-device draft is staged. One will finish only after the vault save is verified.",
  "one.location.circle_retry.title": "Circle setup needs another try",
  "one.location.circle_retry.body":
    "Nothing was marked complete. Retry the verified Circle provisioning step.",
  "one.location.completion_retry.title": "Location setup needs verification",
  "one.location.completion_retry.body":
    "Your prior steps are preserved. Retry the final server verification.",
  "one.location.intro.title": "Set up Location with One",
  "one.location.intro.body":
    "Review how permission, your current position, saved places, and your personal Circle work together.",
  "one.location.paused.title": "Location setup is paused",
  "one.location.paused.body":
    "Your verified progress is preserved. Resume from the next required step when you’re ready.",
  "one.location.permission_offer.title": "Allow Location access",
  "one.location.permission_offer.body":
    "One will open the system permission prompt only after you continue.",
  "one.location.permission_result.title": "Choose Location access",
  "one.location.permission_result.body":
    "Choose Allow While Using App in the system prompt. One will continue only from the real device result.",
  "one.location.place_choice.title": "Choose how to save this place",
  "one.location.place_choice.body":
    "Select Home, Work, another label, or Skip in the approved Location form.",
  "one.location.place_persisting.title": "Save this place",
  "one.location.place_persisting.body":
    "Confirm the place in the approved Location form. One will wait for a verified save result.",
  "one.location.position_pending.title": "Finding your location",
  "one.location.position_pending.body":
    "One is waiting for a real GPS fix from this device.",
  "one.location.position_retry.title": "Location wasn’t ready",
  "one.location.position_retry.body":
    "No verified GPS fix arrived within 30 seconds. Check signal and permission, then try again.",
  "one.location.settings_return.title": "Location needs your attention",
  "one.location.settings_return.body":
    "Open Settings to allow Location for One, then return to continue.",
  "one.location.result.continue.label": "Continue",
  "one.location.result.draft_unavailable.label": "Capture again",
  "one.location.result.open_location.label": "Open Location",
  "one.location.result.open_settings.label": "Open Settings",
  "one.location.result.pause.label": "Not now",
  "one.location.result.permission_denied.label": "Permission denied",
  "one.location.result.permission_granted.label": "Permission granted",
  "one.location.result.permission_restricted.label": "Permission restricted",
  "one.location.result.position_captured.label": "Position captured",
  "one.location.result.position_unavailable.label": "Position unavailable",
  "one.location.result.request_permission.label": "Continue",
  "one.location.result.resume.label": "Resume",
  "one.location.result.retry_circle.label": "Try again",
  "one.location.result.retry_completion.label": "Try again",
  "one.location.result.retry_permission.label": "Try again",
  "one.location.result.retry_position.label": "Try again",
  "one.location.result.save_place.label": "Choose place",
  "one.location.result.services_disabled.label": "Location Services off",
  "one.location.result.settings_returned.label": "I changed it",
  "one.location.result.skip_place.label": "Skip place",
  "one.location.result.vault_unavailable.label": "Save after vault setup",
};

export function locationWorkflowCardCopy(
  key: LocationWorkflowCardCopyKey,
): string {
  return COPY[key];
}

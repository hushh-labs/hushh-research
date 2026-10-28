import type { NativeDrawerProjection } from "./native-drawers";
import { nativePrivacyCanInteract, nativePrivacyCanPrepareProfile, nativePrivacyObservation,
  type NativeSessionPrivacyState } from "./session-privacy";

export const PROFILE_PREPARATION_SCENES = ["account-name", "referral-handle", "phone", "writing-style", "support",
  "vault-passphrase", "request-price", "world-model-fact-edit", "world-model-sources", "world-model-public-profiles", "world-model-invitation",
  "runtime-provider", "connector-custom-server", "connector-profile-link", "connector-packet-price", "memory-financial-context", "payment-funding", "payment-country"] as const;
export type ProfilePreparationScene = typeof PROFILE_PREPARATION_SCENES[number];
export type ProfilePreparationDescription = { visitId: string; formScene: ProfilePreparationScene | null };
export function nativeProfileTargetCanPrepare(state: NativeSessionPrivacyState | undefined | null,
  description: ProfilePreparationDescription | undefined): boolean {
  if (nativePrivacyCanInteract(state ?? undefined)) return true;
  return !!state && nativePrivacyCanPrepareProfile(state) && !!description &&
    state.preparationBody !== "pane" &&
    state.preparationVisitId === description.visitId && state.preparationFormScene === description.formScene;
}

// Current acknowledged parent metadata only. Never retain a private projection,
// draft, account identifier or operation in this preparation boundary.
let parent: { document: string; owner: string; privacy: number; destination?: string; scene: ProfilePreparationScene | null } | null = null;
export function acknowledgeNativeProfilePreparation(state: NativeDrawerProjection) {
  if (state.family !== "profile" || !state.profilePreparation) return;
  parent = { document: state.documentId, owner: state.ownerEpoch, privacy: state.privacyGeneration,
    destination: state.profileDestinationId ?? state.profileSupportDestinationId, scene: state.profilePreparation.formScene };
}
export function nativeProfileSceneCanPrepare(state: NativeSessionPrivacyState | undefined | null,
  scene: string, destination?: string): boolean {
  if (nativePrivacyCanInteract(state ?? undefined)) return true;
  return !!state && nativePrivacyCanPrepareProfile(state) && !!parent &&
    state.preparationBody !== "pane" &&
    parent.privacy === state.generation && parent.scene === scene && parent.destination === destination &&
    state.preparationFormScene === scene;
}
export function nativeProfileActionsAllowed(): boolean {
  return nativePrivacyCanInteract(nativePrivacyObservation().state);
}

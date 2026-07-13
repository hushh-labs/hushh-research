import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";

import type { MorphyAxSnapshotV1 } from "./types";

export function buildMorphyAxSnapshot(
  voice: OneVoiceContextSnapshot,
  access?: { signedIn?: boolean },
): MorphyAxSnapshotV1 {
  return {
    schema_version: "morphy_ax_snapshot.v1",
    snapshot_id: `ax_${voice.snapshot_id}`,
    revisions: { ...voice.revisions },
    access: {
      signed_in:
        access?.signedIn ?? voice.onboarding.phase !== "anonymous_auth",
      vault_ready: voice.cache.vault_ready,
      persona: voice.persona.active,
    },
    context: {
      screen: voice.route.screen,
      route_family: voice.route.route_family,
      playbook_id: voice.route.playbook_id,
      visible_modules: [...voice.ui.visible_modules],
      visible_control_ids: [...voice.ui.visible_control_ids],
      interaction_layer: voice.ui.interaction_layer
        ? {
            ...voice.ui.interaction_layer,
            visible_action_ids: [
              ...voice.ui.interaction_layer.visible_action_ids,
            ],
            visible_control_ids: [
              ...voice.ui.interaction_layer.visible_control_ids,
            ],
            options: voice.ui.interaction_layer.options.map((option) => ({
              ...option,
            })),
          }
        : null,
      onboarding: {
        ...voice.onboarding,
        setup_capability_ids: [...voice.onboarding.setup_capability_ids],
      },
    },
    tools: {
      available_action_ids: [...voice.available_action_ids],
    },
    orchestration: {
      pending_settlement: voice.pending_settlement,
      voice: {
        ...voice.voice,
        last_transition: voice.voice.last_transition
          ? { ...voice.voice.last_transition }
          : null,
      },
      busy_operations: [...voice.cache.busy_operations],
    },
    privacy: {
      redacted: true,
      excludes: [...voice.privacy.excludes],
    },
  };
}

/** Compatibility projection: the existing backend wire contract remains unchanged. */
export function toOneVoiceContextSnapshot(
  ax: MorphyAxSnapshotV1,
  baseline: OneVoiceContextSnapshot,
): OneVoiceContextSnapshot {
  const projectedUi: OneVoiceContextSnapshot["ui"] = {
    ...baseline.ui,
    visible_modules: [...ax.context.visible_modules],
    visible_control_ids: [...ax.context.visible_control_ids],
  };
  if (ax.context.interaction_layer || "interaction_layer" in baseline.ui) {
    projectedUi.interaction_layer = ax.context.interaction_layer
      ? {
          ...ax.context.interaction_layer,
          visible_action_ids: [
            ...ax.context.interaction_layer.visible_action_ids,
          ],
          visible_control_ids: [
            ...ax.context.interaction_layer.visible_control_ids,
          ],
          options: ax.context.interaction_layer.options.map((option) => ({
            ...option,
          })),
        }
      : null;
  }
  return {
    ...baseline,
    revisions: { ...ax.revisions },
    route: {
      ...baseline.route,
      screen: ax.context.screen,
      route_family: ax.context.route_family,
      playbook_id: ax.context.playbook_id,
    },
    ui: projectedUi,
    available_action_ids: [...ax.tools.available_action_ids],
    pending_settlement: ax.orchestration.pending_settlement,
    cache: {
      ...baseline.cache,
      vault_ready: ax.access.vault_ready,
      busy_operations: [...ax.orchestration.busy_operations],
    },
    persona: { ...baseline.persona, active: ax.access.persona },
    onboarding: {
      ...ax.context.onboarding,
      setup_capability_ids: [...ax.context.onboarding.setup_capability_ids],
    },
    voice: {
      ...ax.orchestration.voice,
      last_transition: ax.orchestration.voice.last_transition
        ? { ...ax.orchestration.voice.last_transition }
        : null,
    },
    privacy: {
      redacted: true,
      excludes: [...ax.privacy.excludes],
    },
  };
}

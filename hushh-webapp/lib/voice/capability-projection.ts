import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import {
  evaluateKaiActionAvailability,
  getKaiActionById,
  type KaiActionAvailability,
  type KaiActionDefinition,
} from "@/lib/voice/kai-action-gateway";
import { resolveNavigationJourney } from "@/lib/voice/navigation-journey";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

/**
 * Redacted, UI-safe state used to decide whether One may offer an action.
 * It deliberately contains no slots, phone values, OTPs, vault material, or
 * data records. Server validators remain authoritative for consent and data
 * relationship guards.
 */
export type VoiceCapabilityStateV1 = {
  schema_version: "one.voice_capability_state.v1";
  app: Pick<AppRuntimeState, "auth" | "vault" | "route" | "runtime" | "persona">;
  onboarding: Pick<
    OneVoiceContextSnapshot["onboarding"],
    "phase" | "root_resolved" | "phone_verified" | "callback_state"
  >;
  interaction_layer: Pick<
    OneVoiceContextSnapshot["ui"],
    "visible_control_ids" | "interaction_layer"
  >;
  available_action_ids: readonly string[];
  route_revision: string;
  ui_revision: string;
};

export type CapabilityProjectionStatus =
  | "current_control_executable"
  | "cross_surface_journey"
  | "input_needed"
  | "confirmation_needed"
  | "blocked"
  | "terminal"
  | "manual_only"
  | "unwired"
  | "dead";

export type CapabilityProjectionV1 = {
  schema_version: "one.capability_projection.v1";
  action_id: string;
  status: CapabilityProjectionStatus;
  reason: string | null;
  action: KaiActionDefinition | null;
  availability: KaiActionAvailability | null;
};

function isPhoneCodeStep(state: VoiceCapabilityStateV1): boolean {
  return state.available_action_ids.includes("phone_mandate.submit_code");
}

function isPhoneNumberStep(state: VoiceCapabilityStateV1): boolean {
  return state.available_action_ids.includes("phone_mandate.submit_number");
}

function terminalProjection(
  action: KaiActionDefinition,
  reason: string,
): CapabilityProjectionV1 {
  return {
    schema_version: "one.capability_projection.v1",
    action_id: action.action_id,
    status: "terminal",
    reason,
    action,
    availability: null,
  };
}

function blockedProjection(
  action: KaiActionDefinition,
  reason: string,
  availability: KaiActionAvailability | null = null,
): CapabilityProjectionV1 {
  return {
    schema_version: "one.capability_projection.v1",
    action_id: action.action_id,
    status: "blocked",
    reason,
    action,
    availability,
  };
}

export function deriveVoiceCapabilityState(input: {
  appRuntimeState: AppRuntimeState;
  snapshot: OneVoiceContextSnapshot;
}): VoiceCapabilityStateV1 {
  return {
    schema_version: "one.voice_capability_state.v1",
    app: {
      auth: input.appRuntimeState.auth,
      vault: input.appRuntimeState.vault,
      route: input.appRuntimeState.route,
      runtime: input.appRuntimeState.runtime,
      persona: input.appRuntimeState.persona,
    },
    onboarding: {
      phase: input.snapshot.onboarding.phase,
      root_resolved: input.snapshot.onboarding.root_resolved,
      phone_verified: input.snapshot.onboarding.phone_verified,
      callback_state: input.snapshot.onboarding.callback_state,
    },
    interaction_layer: {
      visible_control_ids: input.snapshot.ui.visible_control_ids,
      interaction_layer: input.snapshot.ui.interaction_layer,
    },
    available_action_ids: input.snapshot.available_action_ids,
    route_revision: input.snapshot.revisions.route,
    ui_revision: input.snapshot.revisions.ui,
  };
}

/**
 * Classifies an action without widening its executable inventory. This is a
 * discovery/UX projection only; executeAgentGatewayAction and server guards
 * still revalidate immediately before an action is dispatched.
 */
export function projectKaiActionCapability(input: {
  actionId: string;
  state: VoiceCapabilityStateV1;
  surfaceMetadata?: VoiceSurfaceMetadata | null;
}): CapabilityProjectionV1 {
  const action = getKaiActionById(input.actionId);
  if (!action) {
    return {
      schema_version: "one.capability_projection.v1",
      action_id: input.actionId,
      status: "dead",
      reason: "Action is not generated.",
      action: null,
      availability: null,
    };
  }

  if (
    action.action_id === "onboarding.claim_one" &&
    (input.state.app.auth.signed_in || input.state.onboarding.root_resolved)
  ) {
    return terminalProjection(action, "One is already claimed for this session.");
  }
  if (
    action.action_id === "setup.hub_master_ack" &&
    input.state.onboarding.root_resolved
  ) {
    return terminalProjection(action, "Setup acknowledgement is already complete.");
  }
  if (action.action_id === "phone_mandate.submit_number") {
    if (input.state.onboarding.phone_verified === true) {
      return terminalProjection(action, "Phone verification is already complete.");
    }
    if (input.state.onboarding.phase !== "phone_required" || !isPhoneNumberStep(input.state)) {
      return blockedProjection(action, "Phone number entry is not active.");
    }
  }
  if (action.action_id === "phone_mandate.submit_code") {
    if (input.state.onboarding.phone_verified === true) {
      return terminalProjection(action, "Phone verification is already complete.");
    }
    if (input.state.onboarding.phase !== "phone_required" || !isPhoneCodeStep(input.state)) {
      return blockedProjection(action, "Send a verification code before confirming it.");
    }
  }

  const availability = evaluateKaiActionAvailability({
    action,
    appRuntimeState: input.state.app as AppRuntimeState,
    surfaceMetadata: input.surfaceMetadata,
  });
  if (availability.status === "dead") {
    return { schema_version: "one.capability_projection.v1", action_id: action.action_id, status: "dead", reason: availability.reason, action, availability };
  }
  if (availability.status === "unwired") {
    return { schema_version: "one.capability_projection.v1", action_id: action.action_id, status: "unwired", reason: availability.reason, action, availability };
  }
  if (availability.status === "manual_only") {
    return { schema_version: "one.capability_projection.v1", action_id: action.action_id, status: "manual_only", reason: availability.reason, action, availability };
  }
  if (availability.status === "blocked") {
    return blockedProjection(action, availability.reason || "Action is unavailable.", availability);
  }
  if (action.execution_policy === "confirm_required") {
    return { schema_version: "one.capability_projection.v1", action_id: action.action_id, status: "confirmation_needed", reason: null, action, availability };
  }
  if (action.goal.required_inputs.some((item) => item.required)) {
    // An action whose contract authors a navigate-then-execute journey stays
    // reachable from anywhere, so it is a journey rather than a dead end
    // waiting on input. Resolved from the contract, not by action id: this
    // read `=== "analysis.start"`, which capped the app at one journey.
    if (resolveNavigationJourney(action.action_id, action)) {
      return { schema_version: "one.capability_projection.v1", action_id: action.action_id, status: "cross_surface_journey", reason: null, action, availability };
    }
    return { schema_version: "one.capability_projection.v1", action_id: action.action_id, status: "input_needed", reason: null, action, availability };
  }
  if (input.state.available_action_ids.includes(action.action_id)) {
    return { schema_version: "one.capability_projection.v1", action_id: action.action_id, status: "current_control_executable", reason: null, action, availability };
  }
  if (
    action.execution_target.status === "wired" &&
    action.execution_target.path === "route"
  ) {
    return { schema_version: "one.capability_projection.v1", action_id: action.action_id, status: "cross_surface_journey", reason: null, action, availability };
  }
  return blockedProjection(action, "That control is not mounted on this screen.", availability);
}

export function isDiscoverableCapability(projection: CapabilityProjectionV1): boolean {
  return (
    projection.status === "current_control_executable" ||
    projection.status === "cross_surface_journey" ||
    projection.status === "input_needed" ||
    projection.status === "confirmation_needed"
  );
}

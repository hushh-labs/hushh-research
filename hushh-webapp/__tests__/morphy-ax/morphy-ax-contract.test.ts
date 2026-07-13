import { describe, expect, it } from "vitest";

import {
  buildMorphyAxSnapshot,
  resolveMorphyAxPresentation,
  toOneVoiceContextSnapshot,
  validateMorphyAxAssessment,
  type MorphyAxAssessmentV1,
} from "@/lib/morphy-ax";
import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";

function voiceFixture(): OneVoiceContextSnapshot {
  return {
    schema_version: "one_voice_context.v1",
    snapshot_id: "ctx_fixture",
    revisions: { route: "r1", ui: "u1", cache: "c1", persona: "p1", voice: 2 },
    route: {
      screen: "one_intro",
      playbook_id: "route.one.intro",
      route_family: "/",
      nav_stack: [],
    },
    ui: {
      visible_modules: ["One intro"],
      visible_control_ids: ["claim-your-one"],
      selected_entity_present: false,
    },
    available_action_ids: ["onboarding.claim_one"],
    pending_settlement: false,
    cache: {
      vault_ready: false,
      portfolio_ready: false,
      busy_operations: [],
      freshness: "locked",
    },
    persona: {
      active: "investor",
      primary_nav: "investor",
      available: ["investor"],
    },
    onboarding: {
      phase: "anonymous_auth",
      active_capability: null,
      root_resolved: false,
      return_route: "/one/setup",
      phone_verified: null,
      callback_state: "none",
      setup_capability_ids: [],
    },
    voice: {
      state: "listening",
      transition_seq: 2,
      session_id: null,
      source_id: null,
      last_transition: null,
    },
    world_model: { summary_available: false, mode: "redacted_summary_only" },
    privacy: {
      redacted: true,
      excludes: ["raw_transcript", "credentials", "vault_material"],
    },
  };
}

function assessment(
  overrides: Partial<MorphyAxAssessmentV1> = {},
): MorphyAxAssessmentV1 {
  return {
    schema_version: "morphy_ax_assessment.v1",
    source: "one",
    disposition: "execute_visible_action",
    candidate_action_id: "onboarding.claim_one",
    missing_input: null,
    ambiguous: false,
    confidence: 1,
    expected_outcome: "action",
    ...overrides,
  };
}

describe("Morphy AX contract", () => {
  it("projects back to the unchanged One Voice wire shape", () => {
    const baseline = voiceFixture();
    const ax = buildMorphyAxSnapshot(baseline);
    const projected = toOneVoiceContextSnapshot(ax, baseline);

    expect(projected).toEqual(baseline);
    expect(ax.privacy.redacted).toBe(true);
    expect(ax.tools.available_action_ids).toEqual(["onboarding.claim_one"]);
  });

  it("admits only intelligence-selected actions visible on the current screen", () => {
    const snapshot = buildMorphyAxSnapshot(voiceFixture());
    expect(validateMorphyAxAssessment(assessment(), snapshot)).toEqual({
      status: "permitted",
      action_id: "onboarding.claim_one",
    });
    expect(
      validateMorphyAxAssessment(
        assessment({ candidate_action_id: "auth.sign_in_apple" }),
        snapshot,
      ),
    ).toEqual({ status: "rejected", reason: "action_not_available_on_screen" });
  });

  it("preserves confirmation as a distinct policy decision", () => {
    const snapshot = buildMorphyAxSnapshot(voiceFixture());
    expect(
      validateMorphyAxAssessment(
        assessment({
          disposition: "confirm_visible_action",
          expected_outcome: "confirmation",
        }),
        snapshot,
      ),
    ).toEqual({
      status: "confirmation_required",
      action_id: "onboarding.claim_one",
    });
  });

  it("enforces the authored top-layer action boundary", () => {
    const baseline = voiceFixture();
    baseline.ui.interaction_layer = {
      layer_id: "login_terms",
      kind: "legal",
      modality: "modal",
      lifecycle_state: "open",
      dismissible: true,
      dismiss_action_id: "auth.close_legal",
      visible_action_ids: ["auth.close_legal"],
      visible_control_ids: ["auth_close_legal"],
      options: [],
      underlying_actions_available: false,
      agent_continuity: "interactive",
    };
    baseline.available_action_ids = [
      "auth.close_legal",
      "onboarding.claim_one",
    ];
    const snapshot = buildMorphyAxSnapshot(baseline);

    expect(
      validateMorphyAxAssessment(
        assessment({ candidate_action_id: "auth.close_legal" }),
        snapshot,
      ),
    ).toEqual({ status: "permitted", action_id: "auth.close_legal" });
    expect(validateMorphyAxAssessment(assessment(), snapshot)).toEqual({
      status: "rejected",
      reason: "action_hidden_by_active_layer",
    });
    expect(toOneVoiceContextSnapshot(snapshot, baseline)).toEqual(baseline);
  });

  it("rejects execution while the active layer is not ready or suppresses One", () => {
    const baseline = voiceFixture();
    baseline.ui.interaction_layer = {
      layer_id: "vault_unlock",
      kind: "credential",
      modality: "blocking",
      lifecycle_state: "opening",
      dismissible: false,
      dismiss_action_id: null,
      visible_action_ids: ["onboarding.claim_one"],
      visible_control_ids: ["vault_unlock"],
      options: [],
      underlying_actions_available: false,
      agent_continuity: "ambient",
    };
    let snapshot = buildMorphyAxSnapshot(baseline);
    expect(validateMorphyAxAssessment(assessment(), snapshot)).toEqual({
      status: "rejected",
      reason: "interaction_layer_not_ready",
    });

    baseline.ui.interaction_layer.lifecycle_state = "open";
    baseline.ui.interaction_layer.agent_continuity = "suppressed";
    snapshot = buildMorphyAxSnapshot(baseline);
    expect(validateMorphyAxAssessment(assessment(), snapshot)).toEqual({
      status: "rejected",
      reason: "agent_suppressed_by_active_layer",
    });
  });

  it("clarifies ambiguity and never converts conversation into an action", () => {
    const snapshot = buildMorphyAxSnapshot(voiceFixture());
    expect(
      validateMorphyAxAssessment(
        assessment({ ambiguous: true, missing_input: "provider" }),
        snapshot,
      ),
    ).toEqual({ status: "clarify", reason: "provider" });
    expect(
      validateMorphyAxAssessment(
        assessment({
          disposition: "answer_conversationally",
          candidate_action_id: null,
          expected_outcome: "conversation",
        }),
        snapshot,
      ),
    ).toEqual({
      status: "conversation",
      disposition: "answer_conversationally",
    });
  });

  it("maps the existing voice FSM without creating another transition authority", () => {
    expect(resolveMorphyAxPresentation("listening")).toBe("listening");
    expect(resolveMorphyAxPresentation("needs_consent")).toBe("confirming");
    expect(resolveMorphyAxPresentation("navigation_settling")).toBe("settling");
    expect(resolveMorphyAxPresentation("error_recovery")).toBe("recovering");
  });

  it("meets the pure snapshot, policy, and presentation budgets over 10,000 runs", () => {
    const baseline = voiceFixture();
    const assessmentFixture = assessment();
    const snapshotSamples: number[] = [];
    const policySamples: number[] = [];
    const presentationSamples: number[] = [];

    for (let index = 0; index < 100; index += 1) {
      const warm = buildMorphyAxSnapshot(baseline);
      validateMorphyAxAssessment(assessmentFixture, warm);
      resolveMorphyAxPresentation("listening");
    }
    for (let index = 0; index < 10_000; index += 1) {
      let started = performance.now();
      const snapshot = buildMorphyAxSnapshot(baseline);
      snapshotSamples.push(performance.now() - started);
      started = performance.now();
      validateMorphyAxAssessment(assessmentFixture, snapshot);
      policySamples.push(performance.now() - started);
      started = performance.now();
      resolveMorphyAxPresentation("listening");
      presentationSamples.push(performance.now() - started);
    }

    const percentile = (values: number[], value: number) => {
      const sorted = [...values].sort((left, right) => left - right);
      return (
        sorted[
          Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)
        ] ?? Infinity
      );
    };
    expect(percentile(snapshotSamples, 0.95)).toBeLessThanOrEqual(5);
    expect(percentile(snapshotSamples, 0.99)).toBeLessThanOrEqual(10);
    expect(percentile(policySamples, 0.95)).toBeLessThanOrEqual(5);
    expect(percentile(policySamples, 0.99)).toBeLessThanOrEqual(10);
    expect(percentile(presentationSamples, 0.95)).toBeLessThanOrEqual(2);
  });
});

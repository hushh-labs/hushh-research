import { afterEach, describe, expect, it } from "vitest";

import { buildOneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import {
  clearVoiceSurfaceMetadata,
  getVoiceSurfaceMetadata,
  publishVoiceSurfaceMetadata,
  type VoiceInteractionLayerV1,
} from "@/lib/voice/voice-surface-metadata";
import type { AppRuntimeState } from "@/lib/voice/voice-types";

const PUBLISHERS = ["route", "chrome", "layer_one", "layer_two", "next_route"];

function runtime(pathname = "/login", screen = "login"): AppRuntimeState {
  return {
    auth: { signed_in: false, user_id: null },
    vault: { unlocked: false, token_available: false, token_valid: false },
    route: { pathname, screen, subview: null },
    runtime: {
      analysis_active: false,
      analysis_ticker: null,
      analysis_run_id: null,
      import_active: false,
      import_run_id: null,
      busy_operations: [],
    },
    portfolio: { has_portfolio_data: false },
    voice: {
      available: true,
      tts_playing: false,
      last_tool_name: null,
      last_ticker: null,
    },
  };
}

function layer(
  id: string,
  overrides: Partial<VoiceInteractionLayerV1> = {},
): VoiceInteractionLayerV1 {
  return {
    schemaVersion: "voice_interaction_layer.v1",
    id,
    kind: "legal_document",
    modality: "modal",
    lifecycle: "open",
    dismissible: true,
    dismissActionId: "auth.close_legal",
    visibleActionIds: ["auth.close_legal"],
    visibleControlIds: ["auth_close_legal"],
    options: [],
    returnFocusControlId: "auth_terms",
    blocksUnderlyingActions: true,
    agentContinuity: "interactive",
    ...overrides,
  };
}

function publishLoginRoute() {
  publishVoiceSurfaceMetadata(
    "route",
    {
      screenId: "login",
      title: "Sign in",
      actions: [
        {
          id: "auth_sign_in_apple",
          actionId: "auth.sign_in_apple",
          label: "Continue with Apple",
        },
        {
          id: "auth_sign_in_google",
          actionId: "auth.sign_in_google",
          label: "Continue with Google",
        },
      ],
      controls: [
        {
          id: "auth_apple",
          actionId: "auth.sign_in_apple",
          label: "Continue with Apple",
        },
        {
          id: "auth_google",
          actionId: "auth.sign_in_google",
          label: "Continue with Google",
        },
      ],
    },
    { role: "route", routeKey: "/login" },
  );
}

function publishLegalLayer(
  publisherId: string,
  value: VoiceInteractionLayerV1,
) {
  publishVoiceSurfaceMetadata(
    publisherId,
    {
      title: "Terms",
      actions: [
        {
          id: "auth_close_legal",
          actionId: "auth.close_legal",
          label: "Close Terms",
        },
      ],
      controls: [
        {
          id: "auth_close_legal",
          actionId: "auth.close_legal",
          label: "Close Terms",
        },
      ],
      interactionLayer: value,
    },
    { role: "interaction_layer", routeKey: "/login" },
  );
}

afterEach(() => {
  PUBLISHERS.forEach(clearVoiceSurfaceMetadata);
});

describe("voice surface interaction-layer composition", () => {
  it("hides route and chrome actions behind a modal layer", () => {
    publishLoginRoute();
    publishVoiceSurfaceMetadata(
      "chrome",
      {
        actions: [
          { id: "route_profile", actionId: "route.profile", label: "Profile" },
        ],
        controls: [
          { id: "profile", actionId: "route.profile", label: "Profile" },
        ],
      },
      { role: "chrome", routeKey: "/login" },
    );
    publishLegalLayer("layer_one", layer("login_terms"));

    const metadata = getVoiceSurfaceMetadata();
    expect(metadata?.actions?.map((action) => action.actionId)).toEqual([
      "auth.close_legal",
    ]);
    expect(metadata?.controls?.map((control) => control.id)).toEqual([
      "auth_close_legal",
    ]);

    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: runtime(),
    });
    expect(snapshot.available_action_ids).toEqual(["auth.close_legal"]);
    expect(snapshot.ui.interaction_layer).toEqual({
      layer_id: "login_terms",
      kind: "legal_document",
      modality: "modal",
      lifecycle_state: "open",
      dismissible: true,
      dismiss_action_id: "auth.close_legal",
      visible_action_ids: ["auth.close_legal"],
      visible_control_ids: ["auth_close_legal"],
      options: [],
      underlying_actions_available: false,
      agent_continuity: "interactive",
    });
  });

  it("ranks a nonmodal layer first while retaining permitted route actions", () => {
    publishLoginRoute();
    publishLegalLayer(
      "layer_one",
      layer("provider_help", {
        kind: "legal_document",
        modality: "nonmodal",
        blocksUnderlyingActions: false,
      }),
    );

    const metadata = getVoiceSurfaceMetadata();
    expect(metadata?.actions?.map((action) => action.actionId)).toEqual([
      "auth.close_legal",
      "auth.sign_in_apple",
      "auth.sign_in_google",
    ]);
    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: runtime(),
    });
    expect(snapshot.available_action_ids).toEqual(
      expect.arrayContaining([
        "auth.close_legal",
        "auth.sign_in_apple",
        "auth.sign_in_google",
      ]),
    );
    expect(snapshot.ui.interaction_layer?.underlying_actions_available).toBe(
      true,
    );
  });

  it("restores the prior layer when a nested layer unmounts", () => {
    publishLoginRoute();
    publishLegalLayer("layer_one", layer("login_terms"));
    publishLegalLayer(
      "layer_two",
      layer("confirm_close", {
        kind: "confirmation",
        dismissActionId: "auth.cancel_close",
        visibleActionIds: ["auth.cancel_close"],
      }),
    );

    expect(getVoiceSurfaceMetadata()?.interactionLayer?.id).toBe(
      "confirm_close",
    );
    clearVoiceSurfaceMetadata("layer_two");
    expect(getVoiceSurfaceMetadata()?.interactionLayer?.id).toBe("login_terms");
  });

  it("evicts stale interaction layers when the route publisher changes route", () => {
    publishLoginRoute();
    publishLegalLayer("layer_one", layer("login_terms"));
    publishVoiceSurfaceMetadata(
      "next_route",
      { screenId: "one_intro", title: "One" },
      { role: "route", routeKey: "/" },
    );

    expect(getVoiceSurfaceMetadata()?.screenId).toBe("one_intro");
    expect(getVoiceSurfaceMetadata()?.interactionLayer).toBeNull();
  });

  it("never exposes actions from a publisher that belongs to the previous route", () => {
    publishLoginRoute();

    const betweenRoutes = buildOneVoiceContextSnapshot({
      appRuntimeState: runtime("/", "one_intro"),
    });
    expect(betweenRoutes.available_action_ids).toEqual([]);
    expect(betweenRoutes.ui.controls || []).toEqual([]);

    publishVoiceSurfaceMetadata(
      "next_route",
      {
        screenId: "one_intro",
        title: "Claim your One",
        actions: [
          {
            id: "onboarding_claim_one",
            actionId: "onboarding.claim_one",
            label: "Claim your One",
          },
        ],
      },
      { role: "route", routeKey: "/" },
    );

    const settledRoute = buildOneVoiceContextSnapshot({
      appRuntimeState: runtime("/", "one_intro"),
    });
    expect(settledRoute.available_action_ids).toContain(
      "onboarding.claim_one",
    );
  });

  it("keeps the static route screen when a feature body publishes chrome", () => {
    publishVoiceSurfaceMetadata(
      "route",
      { screenId: "one_setup_email", title: "KYC setup" },
      { role: "route", routeKey: "/one/setup/email" },
    );
    publishVoiceSurfaceMetadata(
      "chrome",
      {
        screenId: "one_kyc",
        title: "KYC",
        actions: [
          { id: "route_one_kyc", actionId: "route.one_kyc", label: "Open KYC" },
        ],
      },
      { role: "chrome", routeKey: "/one/setup/email" },
    );

    expect(getVoiceSurfaceMetadata()?.screenId).toBe("one_setup_email");
  });
});

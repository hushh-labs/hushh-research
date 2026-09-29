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

function runtime(pathname = "/register-phone", screen = "register_phone"): AppRuntimeState {
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
    kind: "country_picker",
    modality: "modal",
    lifecycle: "open",
    dismissible: true,
    dismissActionId: "phone_mandate.close_country_picker",
    // The picker's own actions, as the phone flow publishes them.
    visibleActionIds: [
      "phone_mandate.select_country",
      "phone_mandate.close_country_picker",
    ],
    visibleControlIds: ["phone-flow-country"],
    options: [],
    returnFocusControlId: "phone-flow-country",
    blocksUnderlyingActions: true,
    agentContinuity: "interactive",
    ...overrides,
  };
}

function publishPhoneRoute() {
  publishVoiceSurfaceMetadata(
    "route",
    {
      screenId: "register_phone",
      title: "Verify your phone",
      actions: [
        {
          id: "phone_submit_number",
          actionId: "phone_mandate.submit_number",
          label: "Submit Phone Number",
        },
        {
          id: "phone_submit_code",
          actionId: "phone_mandate.submit_code",
          label: "Submit Verification Code",
        },
      ],
      controls: [
        {
          id: "phone-flow-number",
          actionId: "phone_mandate.submit_number",
          label: "Submit Phone Number",
        },
        {
          id: "phone-flow-code",
          actionId: "phone_mandate.submit_code",
          label: "Submit Verification Code",
        },
      ],
    },
    { role: "route", routeKey: "/register-phone" },
  );
}

function publishPickerLayer(
  publisherId: string,
  value: VoiceInteractionLayerV1,
) {
  publishVoiceSurfaceMetadata(
    publisherId,
    {
      title: "Country code",
      actions: [
        {
          id: "phone_close_country_picker",
          actionId: "phone_mandate.close_country_picker",
          label: "Close Country Picker",
        },
      ],
      controls: [
        {
          id: "phone-flow-country",
          actionId: "phone_mandate.close_country_picker",
          label: "Close Country Picker",
        },
      ],
      interactionLayer: value,
    },
    { role: "interaction_layer", routeKey: "/register-phone" },
  );
}

afterEach(() => {
  PUBLISHERS.forEach(clearVoiceSurfaceMetadata);
});

describe("voice surface interaction-layer composition", () => {
  it("hides route and chrome actions behind a modal layer", () => {
    publishPhoneRoute();
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
      { role: "chrome", routeKey: "/register-phone" },
    );
    publishPickerLayer("layer_one", layer("phone_country_picker"));

    const metadata = getVoiceSurfaceMetadata();
    expect(metadata?.actions?.map((action) => action.actionId)).toEqual([
      "phone_mandate.close_country_picker",
    ]);
    expect(metadata?.controls?.map((control) => control.id)).toEqual([
      "phone-flow-country",
    ]);

    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: runtime(),
    });
    // Only the picker's actions; the route's submit actions and the chrome
    // Profile action sit behind the modal layer.
    expect(snapshot.available_action_ids).toEqual([
      "phone_mandate.select_country",
      "phone_mandate.close_country_picker",
    ]);
    expect(snapshot.ui.interaction_layer).toEqual({
      layer_id: "phone_country_picker",
      kind: "country_picker",
      modality: "modal",
      lifecycle_state: "open",
      dismissible: true,
      dismiss_action_id: "phone_mandate.close_country_picker",
      visible_action_ids: [
        "phone_mandate.select_country",
        "phone_mandate.close_country_picker",
      ],
      visible_control_ids: ["phone-flow-country"],
      options: [],
      underlying_actions_available: false,
      agent_continuity: "interactive",
    });
  });

  it("ranks a nonmodal layer first while retaining permitted route actions", () => {
    publishPhoneRoute();
    publishPickerLayer(
      "layer_one",
      layer("phone_country_picker", {
        modality: "nonmodal",
        blocksUnderlyingActions: false,
      }),
    );

    const metadata = getVoiceSurfaceMetadata();
    expect(metadata?.actions?.map((action) => action.actionId)).toEqual([
      "phone_mandate.close_country_picker",
      "phone_mandate.submit_number",
      "phone_mandate.submit_code",
    ]);
    const snapshot = buildOneVoiceContextSnapshot({
      appRuntimeState: runtime(),
    });
    expect(snapshot.available_action_ids).toEqual(
      expect.arrayContaining([
        "phone_mandate.close_country_picker",
        "phone_mandate.submit_number",
        "phone_mandate.submit_code",
      ]),
    );
    expect(snapshot.ui.interaction_layer?.underlying_actions_available).toBe(
      true,
    );
  });

  it("restores the prior layer when a nested layer unmounts", () => {
    publishPhoneRoute();
    publishPickerLayer("layer_one", layer("phone_country_picker"));
    publishPickerLayer(
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
    expect(getVoiceSurfaceMetadata()?.interactionLayer?.id).toBe(
      "phone_country_picker",
    );
  });

  it("evicts stale interaction layers when the route publisher changes route", () => {
    publishPhoneRoute();
    publishPickerLayer("layer_one", layer("phone_country_picker"));
    publishVoiceSurfaceMetadata(
      "next_route",
      { screenId: "one_intro", title: "One" },
      { role: "route", routeKey: "/" },
    );

    expect(getVoiceSurfaceMetadata()?.screenId).toBe("one_intro");
    expect(getVoiceSurfaceMetadata()?.interactionLayer).toBeNull();
  });

  it("never exposes actions from a publisher that belongs to the previous route", () => {
    publishPhoneRoute();

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

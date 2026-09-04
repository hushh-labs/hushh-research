import { describe, expect, it } from "vitest";

import { validateSiriExposure } from "../../scripts/voice/generate-kai-action-gateway.mjs";

function action(
  actionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action_id: actionId,
    siri_mode: "unsupported",
    siri_requires_vault: false,
    siri_vault_locked_fallback_action_id: null,
    risk_level: "low",
    execution_policy: "allow_direct",
    execution_target: {
      status: "wired",
      path: "local_handler",
      target: actionId,
    },
    ...overrides,
  };
}

describe("validateSiriExposure", () => {
  it("accepts the four bounded modes and a review-only vault fallback", () => {
    expect(() =>
      validateSiriExposure([
        action("location.pause_updates", {
          siri_mode: "direct",
          siri_requires_vault: true,
          siri_vault_locked_fallback_action_id: "location.open_settings",
        }),
        action("location.open_settings", {
          siri_mode: "review_ui",
          execution_target: {
            status: "wired",
            path: "route",
            target: "/one/location?view=settings",
          },
        }),
        action("location.chat.turn", {
          siri_mode: "conversation_only",
          execution_target: {
            status: "wired",
            path: "voice_tool",
            target: "location_specialist_turn",
          },
        }),
        action("location.trigger_sos"),
      ]),
    ).not.toThrow();
  });

  it("rejects exposed actions that bypass their execution-mode contract", () => {
    expect(() =>
      validateSiriExposure([
        action("location.direct", {
          siri_mode: "direct",
          execution_target: { status: "unwired", reason: "missing" },
        }),
      ]),
    ).toThrow(/direct requires a wired local_handler or control target/);

    expect(() =>
      validateSiriExposure([
        action("location.review", {
          siri_mode: "review_ui",
          execution_policy: "confirm_required",
          execution_target: {
            status: "wired",
            path: "route",
            target: "/one/location",
          },
        }),
      ]),
    ).toThrow(/review_ui requires a wired, low-risk, allow_direct route/);

    expect(() =>
      validateSiriExposure([
        action("location.chat.turn", { siri_mode: "conversation_only" }),
      ]),
    ).toThrow(/conversation_only requires a wired voice_tool target/);
  });

  it("rejects vault metadata outside a direct action or without a review target", () => {
    expect(() =>
      validateSiriExposure([
        action("location.open_settings", {
          siri_mode: "review_ui",
          siri_requires_vault: true,
          execution_target: {
            status: "wired",
            path: "route",
            target: "/one/location?view=settings",
          },
        }),
      ]),
    ).toThrow(/siri_requires_vault is valid only for direct Siri actions/);

    expect(() =>
      validateSiriExposure([
        action("location.pause_updates", {
          siri_mode: "direct",
          siri_requires_vault: true,
          siri_vault_locked_fallback_action_id: "location.missing_review",
        }),
      ]),
    ).toThrow(/must resolve to a review_ui action/);
  });
});

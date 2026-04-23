import { describe, expect, it, vi } from "vitest";

import { waitForVoiceActionSettlement } from "@/lib/voice/voice-action-settlement";

describe("waitForVoiceActionSettlement", () => {
  it("settles navigation from the live route and screen snapshot", async () => {
    const emitTelemetry = vi.fn();

    const result = await waitForVoiceActionSettlement({
      actionId: "nav.profile",
      mode: "execute_and_wait",
      routeBefore: {
        pathname: "/kai",
        screen: "home",
        subview: null,
      },
      expectedRoute: "/profile",
      expectedScreen: "profile",
      getCurrentRoute: () => ({
        pathname: "/profile",
        screen: "profile",
        subview: null,
      }),
      timeoutMs: 20,
      pollIntervalMs: 1,
      emitTelemetry,
    });

    expect(result).toEqual({
      route_after: "/profile",
      screen_after: "profile",
      settled_by: "screen",
      data: undefined,
    });
    expect(emitTelemetry).toHaveBeenCalledWith(
      "action_settlement_succeeded",
      expect.objectContaining({
        action_id: "nav.profile",
        settled_by: "screen",
      })
    );
  });

  it("confirms background starts without waiting for a route change", async () => {
    const emitTelemetry = vi.fn();

    const result = await waitForVoiceActionSettlement({
      actionId: "analysis.start",
      mode: "start_background_and_ack",
      actionStatus: "started",
      routeBefore: {
        pathname: "/kai/analysis",
        screen: "analysis",
        subview: null,
      },
      getCurrentRoute: () => ({
        pathname: "/kai/analysis",
        screen: "analysis",
        subview: null,
      }),
      timeoutMs: 20,
      pollIntervalMs: 1,
      emitTelemetry,
    });

    expect(result).toEqual({
      route_after: "/kai/analysis",
      screen_after: "analysis",
      settled_by: "background_start",
    });
    expect(emitTelemetry).toHaveBeenCalledWith(
      "action_settlement_succeeded",
      expect.objectContaining({
        action_id: "analysis.start",
        settled_by: "background_start",
      })
    );
  });
});

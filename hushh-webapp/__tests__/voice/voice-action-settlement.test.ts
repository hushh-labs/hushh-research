import { describe, expect, it, vi } from "vitest";

import { waitForVoiceActionSettlement } from "@/lib/voice/voice-action-settlement";

describe("waitForVoiceActionSettlement", () => {
  it("settles navigation from the live route and screen snapshot", async () => {
    const emitTelemetry = vi.fn();

    const result = await waitForVoiceActionSettlement({
      actionId: "route.profile",
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
        action_id: "route.profile",
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

  it("waits for the new route publisher instead of settling on a stale surface", async () => {
    let reads = 0;
    const result = await waitForVoiceActionSettlement({
      actionId: "onboarding.claim_one",
      mode: "execute_and_wait",
      actionStatus: "started",
      routeBefore: { pathname: "/", screen: "one_intro", subview: null },
      expectedRoute: "/login",
      expectedScreen: "login",
      getCurrentRoute: () => ({
        pathname: "/login",
        screen: "login",
        subview: null,
      }),
      getCurrentSurfaceMetadata: () => {
        reads += 1;
        return reads < 3
          ? {
              publisherRouteKey: "/",
              screenId: "one_intro",
              title: "Claim your One",
            }
          : {
              publisherRouteKey: "/login",
              screenId: "login",
              title: "Sign in",
            };
      },
      timeoutMs: 50,
      pollIntervalMs: 1,
    });

    expect(reads).toBeGreaterThanOrEqual(3);
    expect(result.settled_by).toBe("screen");
    expect(result.route_after).toBe("/login");
  });
});

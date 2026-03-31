import { describe, expect, it, vi } from "vitest";

import { createVoiceTurnId, logVoiceMetric } from "@/lib/voice/voice-telemetry";

describe("voice-telemetry", () => {
  it("creates a turn id with vturn_ prefix", () => {
    const turnId = createVoiceTurnId();
    expect(turnId.startsWith("vturn_")).toBe(true);
    expect(turnId.length).toBeGreaterThan(10);
  });

  it("logs metric event payload", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logVoiceMetric({
      metric: "tts_stop_button_usage",
      value: 1,
      turnId: "vturn_test",
      tags: { source: "button" },
    });

    expect(spy).toHaveBeenCalledWith(
      "[KAI_VOICE_METRIC]",
      expect.objectContaining({
        event: "kai_voice_metric",
        metric: "tts_stop_button_usage",
        value: 1,
        turn_id: "vturn_test",
      })
    );
    spy.mockRestore();
  });
});

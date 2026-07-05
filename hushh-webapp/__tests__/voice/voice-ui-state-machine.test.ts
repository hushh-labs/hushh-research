import { describe, expect, it } from "vitest";

import {
  canTransitionVoiceUiState,
  createOneVoiceTransition,
  getAllowedVoiceUiTransitions,
  getOneVoiceStateLabel,
  mapAgentVoiceStatusToOneVoiceState,
  normalizeOneVoiceUiState,
} from "@/lib/voice/voice-ui-state-machine";

describe("voice-ui-state-machine", () => {
  it("allows valid progression from idle to listening to processing to speaking", () => {
    expect(canTransitionVoiceUiState("idle", "opening")).toBe(true);
    expect(canTransitionVoiceUiState("opening", "listening")).toBe(true);
    expect(canTransitionVoiceUiState("listening", "understanding")).toBe(true);
    expect(canTransitionVoiceUiState("understanding", "intent_preview")).toBe(true);
    expect(canTransitionVoiceUiState("intent_preview", "needs_consent")).toBe(true);
    expect(canTransitionVoiceUiState("needs_consent", "acting")).toBe(true);
    expect(canTransitionVoiceUiState("acting", "navigation_settling")).toBe(true);
    expect(canTransitionVoiceUiState("navigation_settling", "result")).toBe(true);
    expect(canTransitionVoiceUiState("result", "follow_up")).toBe(true);
    expect(canTransitionVoiceUiState("idle", "sheet_listening")).toBe(true);
    expect(canTransitionVoiceUiState("idle", "retry_ready")).toBe(true);
    expect(canTransitionVoiceUiState("sheet_listening", "sheet_submitting")).toBe(true);
    expect(canTransitionVoiceUiState("sheet_listening", "processing_compact")).toBe(true);
    expect(canTransitionVoiceUiState("sheet_listening", "speaking_compact")).toBe(true);
    expect(canTransitionVoiceUiState("sheet_submitting", "processing_compact")).toBe(true);
    expect(canTransitionVoiceUiState("processing_compact", "speaking_compact")).toBe(true);
    expect(canTransitionVoiceUiState("speaking_compact", "processing_compact")).toBe(true);
    expect(canTransitionVoiceUiState("processing_compact", "sheet_listening")).toBe(true);
    expect(canTransitionVoiceUiState("speaking_compact", "sheet_listening")).toBe(true);
    expect(canTransitionVoiceUiState("speaking_compact", "idle")).toBe(true);
  });

  it("rejects only truly invalid jumps", () => {
    expect(canTransitionVoiceUiState("idle", "processing_compact")).toBe(false);
    expect(canTransitionVoiceUiState("retry_ready", "processing_compact")).toBe(true);
    expect(canTransitionVoiceUiState("retry_ready", "speaking_compact")).toBe(true);
  });

  it("lists available transitions", () => {
    expect(getAllowedVoiceUiTransitions("sheet_muted")).toEqual(
      expect.arrayContaining(["sheet_listening", "sheet_submitting", "idle"])
    );
  });

  it("normalizes legacy and Agent states into the One Voice graph", () => {
    expect(normalizeOneVoiceUiState("sheet_listening")).toBe("listening");
    expect(normalizeOneVoiceUiState("processing_compact")).toBe("understanding");
    expect(normalizeOneVoiceUiState("speaking_compact")).toBe("result");
    expect(mapAgentVoiceStatusToOneVoiceState("connecting")).toBe("opening");
    expect(mapAgentVoiceStatusToOneVoiceState("transcribing")).toBe("understanding");
    expect(mapAgentVoiceStatusToOneVoiceState("speaking")).toBe("result");
    expect(getOneVoiceStateLabel("needs_consent")).toBe("One needs confirmation");
  });

  it("builds accessible transition metadata", () => {
    const transition = createOneVoiceTransition(
      "understanding",
      "error_recovery",
      "network",
      123
    );
    expect(transition).toMatchObject({
      from: "understanding",
      to: "error_recovery",
      atMs: 123,
      reason: "network",
      ariaLive: "assertive",
      label: "One Voice needs attention",
    });
  });
});

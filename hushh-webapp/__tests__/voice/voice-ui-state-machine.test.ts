import { describe, expect, it } from "vitest";

import {
  canTransitionVoiceUiState,
  getAllowedVoiceUiTransitions,
} from "@/lib/voice/voice-ui-state-machine";

describe("voice-ui-state-machine", () => {
  it("allows valid progression from idle to listening to processing to speaking", () => {
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
});

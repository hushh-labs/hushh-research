import { describe, expect, it, vi } from "vitest";

import { handleAgentVoiceTranscriptTurn } from "@/lib/agent/agent-voice-turn";

describe("agent voice turn bridge", () => {
  it("sends good STT transcripts into the shared Agent turn runner", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined);
    const requestReview = vi.fn();

    await handleAgentVoiceTranscriptTurn({
      result: {
        transcript: "start Nvidia analysis",
        uncertain: false,
        reason: null,
      },
      runTurn,
      requestReview,
    });

    expect(runTurn).toHaveBeenCalledWith("start Nvidia analysis", { source: "voice" });
    expect(requestReview).not.toHaveBeenCalled();
  });

  it("requests confirmation instead of running uncertain transcripts", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined);
    const requestReview = vi.fn();

    await handleAgentVoiceTranscriptTurn({
      result: {
        transcript: "",
        uncertain: true,
        reason: "No clear speech.",
      },
      runTurn,
      requestReview,
    });

    expect(runTurn).not.toHaveBeenCalled();
    expect(requestReview).toHaveBeenCalledWith("", "No clear speech.");
  });
});

import { describe, expect, it } from "vitest";

type KaiImportLaunchState = {
  streamId: string;
  status: "idle" | "launching" | "streaming" | "completed";
  analysisStarted: boolean;
};

function buildKaiImportLaunchState(
  streamId: string,
): KaiImportLaunchState {
  return {
    streamId,
    status: "launching",
    analysisStarted: false,
  };
}

describe("Kai import stream launch state", () => {
  it("preserves launch state before analysis starts", () => {
    const state = buildKaiImportLaunchState("stream_123");

    expect(state).toEqual({
      streamId: "stream_123",
      status: "launching",
      analysisStarted: false,
    });
  });
});
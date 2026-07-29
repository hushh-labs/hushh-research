import { describe, expect, it } from "vitest";

type PortfolioImportState = {
  streamId: string | null;
  fallbackStreamId: string | null;
};

function resolveActiveStream(
  state: PortfolioImportState,
): string | null {
  return state.streamId ?? state.fallbackStreamId;
}

describe("portfolio import stream affinity", () => {
  it("preserves fallback stream affinity when primary stream is unavailable", () => {
    const state: PortfolioImportState = {
      streamId: null,
      fallbackStreamId: "stream_fallback_123",
    };

    expect(resolveActiveStream(state)).toBe(
      "stream_fallback_123",
    );
  });
});
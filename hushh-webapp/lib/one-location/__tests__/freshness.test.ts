import { describe, expect, it } from "vitest";
import {
  liveFreshness,
  locationPreviewFreshness,
} from "@/lib/one-location/freshness";

const base = Date.parse("2026-07-09T00:00:00.000Z");

describe("liveFreshness", () => {
  it("reports live within the stale threshold", () => {
    const r = liveFreshness("2026-07-09T00:00:00.000Z", base + 8_000, 60_000);
    expect(r.state).toBe("live");
    expect(r.agoLabel).toBe("8 sec ago");
  });

  it("reports paused past the stale threshold", () => {
    const r = liveFreshness("2026-07-09T00:00:00.000Z", base + 240_000, 60_000);
    expect(r.state).toBe("paused");
    expect(r.agoLabel).toBe("4 min ago");
  });

  it("formats long stale intervals as hours and minutes", () => {
    const r = liveFreshness(
      "2026-07-09T00:00:00.000Z",
      base + 25_500_000,
      60_000,
    );

    expect(r.state).toBe("paused");
    expect(r.agoLabel).toBe("7 hr 5 min ago");
  });

  it("clamps future timestamps to 0s and stays live", () => {
    const r = liveFreshness("2026-07-09T00:00:00.000Z", base - 5_000, 60_000);
    expect(r.state).toBe("live");
    expect(r.agoLabel).toBe("0 sec ago");
  });
});

describe("locationPreviewFreshness", () => {
  it("keeps a fixed Check-In available beyond the live heartbeat threshold", () => {
    const result = locationPreviewFreshness({
      capturedAtISO: "2026-07-09T00:00:00.000Z",
      nowMs: base + 240_000,
      staleThresholdMs: 60_000,
      fixedCheckIn: true,
    });

    expect(result).toEqual({ state: "check_in", agoLabel: "4 min ago" });
  });

  it("still reports a stalled live stream as paused", () => {
    const result = locationPreviewFreshness({
      capturedAtISO: "2026-07-09T00:00:00.000Z",
      nowMs: base + 240_000,
      staleThresholdMs: 60_000,
      fixedCheckIn: false,
    });

    expect(result.state).toBe("paused");
  });
});

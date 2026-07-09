import { describe, expect, it } from "vitest";
import { liveFreshness } from "@/lib/one-location/freshness";

const base = Date.parse("2026-07-09T00:00:00.000Z");

describe("liveFreshness", () => {
  it("reports live within the stale threshold", () => {
    const r = liveFreshness("2026-07-09T00:00:00.000Z", base + 8_000, 60_000);
    expect(r.state).toBe("live");
    expect(r.agoLabel).toBe("8s ago");
  });

  it("reports paused past the stale threshold", () => {
    const r = liveFreshness("2026-07-09T00:00:00.000Z", base + 240_000, 60_000);
    expect(r.state).toBe("paused");
    expect(r.agoLabel).toBe("4m ago");
  });

  it("clamps future timestamps to 0s and stays live", () => {
    const r = liveFreshness("2026-07-09T00:00:00.000Z", base - 5_000, 60_000);
    expect(r.state).toBe("live");
    expect(r.agoLabel).toBe("0s ago");
  });
});

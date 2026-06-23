import { describe, expect, it } from "vitest";

import { resolveObservabilityEventCategory } from "@/lib/observability/events";

describe("resolveObservabilityEventCategory", () => {
  it("classifies system events", () => {
    expect(
      resolveObservabilityEventCategory("page_view"),
    ).toBe("system");
  });

  it("classifies feature events", () => {
    expect(
      resolveObservabilityEventCategory("portfolio_viewed"),
    ).toBe("feature");
  });

  it("classifies funnel events", () => {
    expect(
      resolveObservabilityEventCategory("growth_funnel_step_completed"),
    ).toBe("funnel");
  });

  it("returns a valid category for representative events", () => {
    expect([
      "system",
      "feature",
      "funnel",
    ]).toContain(
      resolveObservabilityEventCategory("analysis_stream_started"),
    );

    expect([
      "system",
      "feature",
      "funnel",
    ]).toContain(
      resolveObservabilityEventCategory("api_request_completed"),
    );
  });
});
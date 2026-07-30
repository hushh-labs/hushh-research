import { describe, expect, it } from "vitest";

import { buildInitialCommandRecommendations } from "@/components/kai/kai-command-palette";

describe("initial command-palette recommendations", () => {
  it("puts the cached One top mover first and preserves its analysis slot", () => {
    const recommendations = buildInitialCommandRecommendations({
      topMover: { symbol: "nvda", companyName: "NVIDIA" },
    });

    expect(recommendations[0]).toEqual({
      actionId: "analysis.start",
      category: "Research",
      label: "Analyze NVDA · NVIDIA",
      slots: { symbol: "NVDA" },
    });
  });

  it("keeps the first viewport short and varied when market data is unavailable", () => {
    const recommendations = buildInitialCommandRecommendations({ topMover: null });

    expect(recommendations).toHaveLength(4);
    expect(recommendations.map((item) => item.category)).toEqual([
      "Research",
      "Memory",
      "Consent",
      "Account",
    ]);
    expect(recommendations[0]).toMatchObject({
      actionId: "analysis.start",
      label: "Start stock analysis",
    });
  });
});

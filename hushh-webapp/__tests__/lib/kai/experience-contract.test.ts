import { describe, it, expect } from "vitest";
import { KAI_EXPERIENCE_CONTRACT } from "@/lib/kai/experience-contract";

describe("KAI_EXPERIENCE_CONTRACT", () => {
  it("exposes exactly the portfolioClarity and decisionConviction top-level keys", () => {
    expect(Object.keys(KAI_EXPERIENCE_CONTRACT).sort()).toEqual(
      ["decisionConviction", "portfolioClarity"].sort()
    );
  });

  describe("portfolioClarity", () => {
    it("exposes exactly the documented keys", () => {
      expect(Object.keys(KAI_EXPERIENCE_CONTRACT.portfolioClarity).sort()).toEqual(
        [
          "carouselTitle",
          "carouselAccent",
          "dashboardPrimarySection",
          "dashboardPrimaryDescription",
        ].sort()
      );
    });

    it("has the exact string values", () => {
      expect(KAI_EXPERIENCE_CONTRACT.portfolioClarity.carouselTitle).toBe(
        "Everything you hold,"
      );
      expect(KAI_EXPERIENCE_CONTRACT.portfolioClarity.carouselAccent).toBe(
        "in one place"
      );
      expect(
        KAI_EXPERIENCE_CONTRACT.portfolioClarity.dashboardPrimarySection
      ).toBe("Top Holdings");
      expect(
        KAI_EXPERIENCE_CONTRACT.portfolioClarity.dashboardPrimaryDescription
      ).toBe("Performance, allocation, and risk in one real-data surface.");
    });
  });

  describe("decisionConviction", () => {
    it("exposes exactly the documented keys", () => {
      expect(Object.keys(KAI_EXPERIENCE_CONTRACT.decisionConviction).sort()).toEqual(
        [
          "carouselTitle",
          "carouselAccent",
          "dashboardRecommendationsSection",
          "dashboardRecommendationsDescription",
        ].sort()
      );
    });

    it("has the exact string values", () => {
      expect(KAI_EXPERIENCE_CONTRACT.decisionConviction.carouselTitle).toBe(
        "Buy, sell,"
      );
      expect(KAI_EXPERIENCE_CONTRACT.decisionConviction.carouselAccent).toBe(
        "hold"
      );
      expect(
        KAI_EXPERIENCE_CONTRACT.decisionConviction.dashboardRecommendationsSection
      ).toBe("Recommendations");
      expect(
        KAI_EXPERIENCE_CONTRACT.decisionConviction
          .dashboardRecommendationsDescription
      ).toBe(
        "Action paths grounded in parsed holdings, concentration, and risk context."
      );
    });
  });

  it("all leaf values are strings", () => {
    const allValues = [
      ...Object.values(KAI_EXPERIENCE_CONTRACT.portfolioClarity),
      ...Object.values(KAI_EXPERIENCE_CONTRACT.decisionConviction),
    ];
    allValues.forEach((value) => expect(typeof value).toBe("string"));
  });
});
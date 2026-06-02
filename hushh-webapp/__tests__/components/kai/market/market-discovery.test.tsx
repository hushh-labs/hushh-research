import { describe, expect, it } from "vitest";
import { signalEvidenceItems } from "@/components/kai/market/market-discovery";

describe("market-discovery", () => {
  describe("signalEvidenceItems", () => {
    it("handles undefined signal safely", () => {
      const items = signalEvidenceItems(undefined);
      expect(items).toEqual([]);
    });

    it("extracts confidence when provided", () => {
      const items = signalEvidenceItems({
        id: "test",
        title: "Test Signal",
        confidence: 0.85,
        source_tags: [],
        degraded: false,
      });
      expect(items).toContainEqual({
        label: "Confidence",
        value: "85%",
      });
    });

    it("includes degraded warning state", () => {
      const items = signalEvidenceItems({
        id: "test",
        title: "Test Signal",
        confidence: 0.85,
        source_tags: [],
        degraded: true,
      });
      expect(items).toContainEqual({
        label: "State",
        value: "Degraded feed",
        tone: "warning",
      });
    });

    it("extracts unique source tags", () => {
      const items = signalEvidenceItems({
        id: "test",
        title: "Test Signal",
        confidence: 0.5,
        source_tags: ["Source A", "Source B", "Source A", "fallback"],
        degraded: false,
      });
      const sourceItems = items.filter(i => i.label === "Source");
      expect(sourceItems.length).toBeLessThanOrEqual(2);
      expect(items).not.toContainEqual({
        label: "Source",
        value: "fallback",
      });
    });
  });
});

import { describe, expect, it } from "vitest";
import { customCircleTypeGroups, normalizeCircleTypeLabel } from "@/lib/one-location/circle-types";
import type { OneLocationCircleSummary } from "@/lib/one-location/types";

const circle = (id: string, label: string, role: "owner" | "member" = "owner"): OneLocationCircleSummary => ({
  id, name: id, kind: "other", role, memberCount: 0, memberLimit: 20, customTypeLabel: label,
});
describe("custom Circle types", () => {
  it("normalizes labels without mutating the Circle name", () => {
    expect(normalizeCircleTypeLabel(" Ｆｉｎａｎｃｅ  team ")).toBe("Finance team");
    const input = [circle("Investments", "Finance"), circle("Tax records", " finance ")];
    expect(customCircleTypeGroups(input)).toEqual([{ label: "Finance", circles: input }]);
    expect(input.map(item => item.name)).toEqual(["Investments", "Tax records"]);
  });
  it("uses only owned ordinary circles and removes a type when its last circle is gone", () => {
    expect(customCircleTypeGroups([circle("joined", "Finance", "member"), { ...circle("system", "Finance"), isSystem: true }, circle("invalid", "Family")])).toEqual([]);
    expect(customCircleTypeGroups([])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { driveEtaText } from "@/app/one/location/drive-eta";

describe("driveEtaText", () => {
  it("formats minutes", () => {
    expect(driveEtaText(600)).toBe("~10 min away");
  });
  it("formats hours + minutes", () => {
    expect(driveEtaText(3900)).toBe("~1 hr 5 min away");
  });
  it("handles arrival", () => {
    expect(driveEtaText(30)).toBe("Arriving now");
  });
  it("handles missing eta", () => {
    expect(driveEtaText(null)).toBe("ETA unavailable");
  });
});

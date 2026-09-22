import { describe, expect, it } from "vitest";

import { isFocusedLocationBottomTask } from "@/lib/navigation/location-routes";

describe("focused Location bottom-task chrome policy", () => {
  it.each(["ask", "share", "sos"])(
    "gives ?action=%s exclusive ownership of the bottom interaction edge",
    (action) => {
      expect(isFocusedLocationBottomTask("/one/location", action)).toBe(true);
    },
  );

  it.each([undefined, "", "settings", "active-shares", "needs-review"])(
    "keeps persistent chrome for the non-terminal %s surface",
    (action) => {
      expect(isFocusedLocationBottomTask("/one/location", action)).toBe(false);
    },
  );

  it("does not apply a Location query policy to another route", () => {
    expect(isFocusedLocationBottomTask("/one", "ask")).toBe(false);
  });
});

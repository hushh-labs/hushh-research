import { describe, expect, it } from "vitest";

import { resolveBottomNavAction } from "@/lib/navigation/app-bottom-nav";

describe("connect bottom-nav routing", () => {
  it("routes to /connect in the one scope", () => {
    expect(resolveBottomNavAction("connect", "one")).toEqual({ type: "route", href: "/connect" });
  });

  it("routes to /marketplace in the investor scope", () => {
    expect(resolveBottomNavAction("connect", "investor")).toEqual({ type: "route", href: "/marketplace" });
  });

  it("routes to /marketplace in the ria scope", () => {
    expect(resolveBottomNavAction("connect", "ria")).toEqual({ type: "route", href: "/marketplace" });
  });
});

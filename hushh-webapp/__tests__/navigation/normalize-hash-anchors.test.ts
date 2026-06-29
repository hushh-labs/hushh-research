import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

describe("normalizeInternalRouteHref -- hash anchors", () => {
  it("accepts root hash anchors but rejects bare hash-only anchors", () => {
    expect(normalizeInternalRouteHref("/#top")).toBe("/#top");
    expect(normalizeInternalRouteHref("  /#top  ")).toBe("/#top");

    expect(normalizeInternalRouteHref("#top")).toBeNull();
    expect(normalizeInternalRouteHref("  #top  ")).toBeNull();
  });
});

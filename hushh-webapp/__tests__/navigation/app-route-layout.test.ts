import { describe, expect, it } from "vitest";

import { resolveAppRouteLayoutMode } from "@/lib/navigation/app-route-layout";

describe("app route layout", () => {
  it("matches the RIA clients layout contract across redundant slash separators", () => {
    expect(resolveAppRouteLayoutMode("/ria////clients")).toBe("standard");
  });
});

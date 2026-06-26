import { describe, expect, it } from "vitest";

import { getRouteScope } from "@/lib/navigation/route-scope";
import { ROUTES } from "@/lib/navigation/routes";

describe("getRouteScope", () => {
  it("resolves the login route to public scope", () => {
    expect(getRouteScope(ROUTES.LOGIN)).toBe("public");
  });
});
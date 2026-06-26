import { describe, expect, it } from "vitest";

import { buildPhoneMandateRoute } from "@/lib/navigation/routes";

describe("buildPhoneMandateRoute", () => {
  it("returns the base route when redirect is missing", () => {
    expect(buildPhoneMandateRoute()).toBe("/register-phone");
    expect(buildPhoneMandateRoute(null)).toBe("/register-phone");
  });

  it("returns the base route for whitespace-only redirect values", () => {
    expect(buildPhoneMandateRoute("  ")).toBe("/register-phone");
  });

  it("includes the redirect query parameter when provided", () => {
    expect(buildPhoneMandateRoute("/one")).toBe(
      "/register-phone?redirect=%2Fone"
    );
  });
});
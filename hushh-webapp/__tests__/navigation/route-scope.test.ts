import { describe, expect, it } from "vitest";

import { getRouteScope } from "@/lib/navigation/route-scope";

describe("getRouteScope", () => {
  it("classifies onboarding paths, including the ria onboarding override", () => {
    expect(getRouteScope("/one/onboarding")).toBe(
      "onboarding",
    );

    expect(getRouteScope("/ria/onboarding")).toBe(
      "onboarding",
    );
  });

  it("classifies investor paths", () => {
    expect(getRouteScope("/one/kai")).toBe(
      "investor",
    );

    expect(getRouteScope("/kai")).toBe(
      "investor",
    );
  });

  it("classifies ria paths that are not onboarding", () => {
    expect(getRouteScope("/ria")).toBe("ria");

    expect(
      getRouteScope("/ria/clients"),
    ).toBe("ria");
  });

  it("classifies shared paths", () => {
    expect(
      getRouteScope("/marketplace"),
    ).toBe("shared");

    expect(getRouteScope("/profile")).toBe(
      "shared",
    );
  });

  it("classifies public paths", () => {
    expect(getRouteScope("/login")).toBe(
      "public",
    );

    expect(getRouteScope("/logout")).toBe(
      "public",
    );
  });

  it("classifies unrecognized and empty paths as unknown", () => {
    expect(
      getRouteScope("/some/unmapped/path"),
    ).toBe("unknown");

    expect(getRouteScope("")).toBe(
      "unknown",
    );
  });
});
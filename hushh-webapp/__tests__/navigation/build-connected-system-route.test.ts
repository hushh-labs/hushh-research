import { describe, expect, it } from "vitest";

import { buildConnectedSystemRoute } from "@/lib/navigation/routes";

describe("buildConnectedSystemRoute", () => {
  it("returns the base route for missing or empty values", () => {
    expect(buildConnectedSystemRoute()).toBe("/one/connected-systems");
    expect(buildConnectedSystemRoute(null)).toBe("/one/connected-systems");
    expect(buildConnectedSystemRoute("")).toBe("/one/connected-systems");
  });

  it("returns the base route for whitespace-only values", () => {
    expect(buildConnectedSystemRoute("  ")).toBe(
      "/one/connected-systems"
    );
  });

  it("appends a system id when provided", () => {
    expect(buildConnectedSystemRoute("plaid")).toBe(
      "/one/connected-systems/plaid"
    );
  });

  it("encodes route segments using encodeURIComponent", () => {
    expect(buildConnectedSystemRoute("my system")).toBe(
      "/one/connected-systems/my%20system"
    );

    expect(buildConnectedSystemRoute("a/b")).toBe(
      "/one/connected-systems/a%2Fb"
    );
  });
});
import { describe, expect, it } from "vitest";

import { buildMarketplaceRiaProfileRoute } from "@/lib/navigation/routes";

describe("buildMarketplaceRiaProfileRoute", () => {
  it("returns the base route when riaId is missing", () => {
    expect(buildMarketplaceRiaProfileRoute()).toBe("/marketplace/ria");
    expect(buildMarketplaceRiaProfileRoute(null)).toBe("/marketplace/ria");
  });

  it("returns the base route for whitespace-only riaId", () => {
    expect(buildMarketplaceRiaProfileRoute("  ")).toBe(
      "/marketplace/ria"
    );
  });

  it("adds riaId when provided", () => {
    expect(buildMarketplaceRiaProfileRoute("ria-123")).toBe(
      "/marketplace/ria?riaId=ria-123"
    );
  });

  it("serializes spaces using URLSearchParams behavior", () => {
    expect(buildMarketplaceRiaProfileRoute("has space")).toBe(
      "/marketplace/ria?riaId=has+space"
    );
  });
});
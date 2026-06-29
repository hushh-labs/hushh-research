import { describe, expect, it } from "vitest";
import { normalizeRoute } from "@/components/app-ui/native-test-router";

describe("normalizeRoute", () => {
  it("returns / for empty string", () => {
    expect(normalizeRoute("")).toBe("/");
  });

  it("returns / for null", () => {
    expect(normalizeRoute(null)).toBe("/");
  });

  it("strips trailing slash from path", () => {
    expect(normalizeRoute("/profile/")).toBe("/profile");
  });

  it("preserves query string", () => {
    expect(normalizeRoute("/one/kai?tab=analysis")).toBe("/one/kai?tab=analysis");
  });

  it("normalises full URL to pathname and search", () => {
    expect(normalizeRoute("https://native-test.local/one/kai?tab=analysis")).toBe("/one/kai?tab=analysis");
  });
});

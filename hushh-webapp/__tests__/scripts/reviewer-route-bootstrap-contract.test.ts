import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const scripts = [
  "../../scripts/testing/verify-signed-in-routes.mjs",
  "../../scripts/testing/run-kai-import-e2e.mjs",
];

describe("reviewer route bootstrap contract", () => {
  it.each(scripts)("accepts the governed RIA onboarding redirect in %s", (relativePath) => {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");

    expect(source).toContain(
      'const REVIEWER_BOOTSTRAP_ROUTE_IDS = [REVIEWER_BOOTSTRAP_ROUTE, "/ria/onboarding"]'
    );
    expect(source).toContain("waitForRouteBeacon(page, REVIEWER_BOOTSTRAP_ROUTE_IDS)");
  });

  it("accepts state-aware destinations for Kai onboarding compatibility redirects", () => {
    const verifierPath = scripts[0];
    const source = readFileSync(new URL(verifierPath, import.meta.url), "utf8");

    expect(source).toContain('"/one/setup/finance"');
    expect(source).toContain('"/one/kai"');
    expect(source).toMatch(
      /if \(route\.mode === "redirect"\) \{[\s\S]*const override = ROUTE_OVERRIDES\[route\.route\];[\s\S]*override\?\.allowedPathnames/,
    );
  });
});

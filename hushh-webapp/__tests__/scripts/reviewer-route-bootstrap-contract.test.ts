import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const scripts = [
  "../../scripts/testing/verify-signed-in-routes.mjs",
  "../../scripts/testing/run-kai-import-e2e.mjs",
];

describe("reviewer route bootstrap contract", () => {
  it.each(scripts)(
    "accepts the governed RIA onboarding redirect in %s",
    (relativePath) => {
      const source = readFileSync(
        new URL(relativePath, import.meta.url),
        "utf8",
      );

      expect(source).toMatch(
        /const REVIEWER_BOOTSTRAP_ROUTE_IDS = \[\s*REVIEWER_BOOTSTRAP_ROUTE,\s*"\/ria\/onboarding",?\s*\]/,
      );
      expect(source).toContain(
        "waitForRouteBeacon(page, REVIEWER_BOOTSTRAP_ROUTE_IDS)",
      );
    },
  );

  it("accepts state-aware destinations for Kai onboarding compatibility redirects", () => {
    const verifierPath = scripts[0];
    const source = readFileSync(new URL(verifierPath, import.meta.url), "utf8");

    expect(source).toContain('"/one/setup/finance"');
    expect(source).toContain('"/one/kai"');
    expect(source).toMatch(
      /if \(route\.mode === "redirect"\) \{[\s\S]*const override = ROUTE_OVERRIDES\[route\.route\];[\s\S]*override\?\.allowedPathnames/,
    );
  });

  it.each([
    [
      "../../components/ria/ria-client-workspace.tsx",
      "/ria/clients/[userId]",
      "native-route-ria-client-workspace",
    ],
    [
      "../../components/ria/ria-client-account-detail.tsx",
      "/ria/clients/[userId]/accounts/[accountId]",
      "native-route-ria-client-account-detail",
    ],
    [
      "../../components/ria/ria-client-request-detail.tsx",
      "/ria/clients/[userId]/requests/[requestId]",
      "native-route-ria-client-request-detail",
    ],
  ])(
    "keeps a terminal reviewer beacon in RIA compatibility mode for %s",
    (relativePath, routeId, marker) => {
      const source = readFileSync(
        new URL(relativePath, import.meta.url),
        "utf8",
      );

      expect(source).toContain(`routeId: "${routeId}"`);
      expect(source).toContain(`marker: "${marker}"`);
      expect(source).toContain('dataState: "unavailable-valid"');
    },
  );

  it("keeps a terminal reviewer beacon in RIA picks setup compatibility mode", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/ria/picks/page.tsx"),
      "utf8",
    );

    expect(source).toMatch(
      /riaCapability === "setup"[\s\S]*routeId: "\/ria\/picks"[\s\S]*marker: "native-route-ria-picks"[\s\S]*dataState: "unavailable-valid"/,
    );
  });

  it("keeps the BYOK reviewer harness on the memory-only passphrase fallback", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "../.codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs",
      ),
      "utf8",
    );

    expect(source).toContain('page.locator("#unlock-passphrase")');
    expect(source).toContain("unlockInput.fill(reviewerPassphrase)");
    expect(source).toContain("bootstrapErrorClass");
    expect(source).toContain("userMatches");
    expect(source).toContain("const maxAttempts = 3");
    expect(source).toContain("await context.close().catch(() => undefined)");
  });

  it("drives an unlock control the vault actually renders", () => {
    // This test used to pin the literal "unlock with passphrase", a phrase that
    // appears NOWHERE in the product. The harness matched it by accessible name,
    // so the locator resolved to nothing, `isEnabled()` threw, the surrounding
    // `.catch(() => false)` swallowed it, and the manual-unlock fallback could
    // never run -- while this test stayed green on the broken string. Pinning a
    // selector without checking the product renders it is a test that cannot fail.
    const harness = readFileSync(
      resolve(
        process.cwd(),
        "../.codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs",
      ),
      "utf8",
    );
    const vaultFlow = readFileSync(
      resolve(process.cwd(), "components/vault/vault-flow.tsx"),
      "utf8",
    );

    expect(harness).not.toContain("unlock with passphrase");
    // The submit button renders "Unlock" (and "Unlocking..." while busy).
    expect(harness).toContain('getByRole("button", { name: /^unlock/i })');
    expect(vaultFlow).toContain('"Unlock"');
    // The passphrase fallback is addressed by a stable testid, which the vault renders.
    expect(harness).toContain('[data-testid="vault-use-passphrase-instead"]');
    expect(vaultFlow).toContain('data-testid="vault-use-passphrase-instead"');
  });
});

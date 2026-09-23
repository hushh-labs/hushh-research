import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { shouldRetryReviewerBootstrap } from "../../../.codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs";

const scripts = [
  "../../scripts/testing/verify-signed-in-routes.mjs",
  "../../scripts/testing/run-kai-import-e2e.mjs",
];

describe("reviewer route bootstrap contract", () => {
  it("does not repeat a terminal reviewer authentication or vault failure", () => {
    expect(shouldRetryReviewerBootstrap({ code: "REVIEWER_TERMINAL_BOOTSTRAP" })).toBe(false);
    expect(shouldRetryReviewerBootstrap({ code: "TRANSIENT_NAVIGATION_ERROR" })).toBe(true);
  });
  it.each(scripts)(
    "uses the owning route's bootstrap contract in %s",
    (relativePath) => {
      const source = readFileSync(
        new URL(relativePath, import.meta.url),
        "utf8",
      );

      if (relativePath.includes("verify-signed-in-routes")) {
        expect(source).toContain('const REVIEWER_BOOTSTRAP_ROUTE = "/"');
        expect(source).not.toContain("bodySnippet:");
        expect(source).not.toContain("bootstrapUserId:");
        expect(source).toContain("await waitForReviewerVaultAdmission(page, smokeUserId, NAVIGATION_TIMEOUT_MS)");
        expect(source).toContain(
          'process.env.REVIEWER_AUTH_MODE === "local_credentials"',
        );
        expect(source).toContain(': "custom_token";');
      } else {
        expect(source).toMatch(
          /const REVIEWER_BOOTSTRAP_ROUTE_IDS = \[\s*REVIEWER_BOOTSTRAP_ROUTE,\s*"\/ria\/onboarding",?\s*\]/,
        );
      }
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
    expect(source).toContain("unlock with passphrase");
    expect(source).toContain("unlockInput.fill(reviewerPassphrase)");
    expect(source).toContain("bootstrapErrorClass");
    expect(source).toContain("userMatches");
    expect(source).toContain("const maxAttempts = 3");
    expect(source).toContain("await context.close().catch(() => undefined)");
  });
});

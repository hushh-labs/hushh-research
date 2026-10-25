import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";
import { installReviewerBridge } from "../../../.agents/skills/reviewer-app-testing/scripts/reviewer-session-bootstrap.mjs";
import { shouldDisableExternalTelemetryForAutomation, shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";

import {
  BEACON_POST_RESPONSE_ABORT,
  classifyCollectSettlement,
} from "../../scripts/testing/analytics-collect-delivery.mjs";
import { getSafeJourneyState } from "../../scripts/testing/analytics-smoke-failure.mjs";

const SMOKE = readFileSync(
  path.resolve(__dirname, "../../scripts/testing/run-uat-analytics-smoke.mjs"),
  "utf8",
);

describe("classifyCollectSettlement", () => {
  it("treats a GA4 2xx followed by the beacon ERR_ABORTED as delivered", () => {
    // Observed on every UAT hit: 204, then requestfailed net::ERR_ABORTED, and
    // no requestfinished at all. This is what kept every UAT deploy rolled back.
    expect(
      classifyCollectSettlement({
        settledBy: "requestfailed",
        responseStatus: 204,
        failureText: BEACON_POST_RESPONSE_ABORT,
      }),
    ).toBe("finished");
  });

  it("treats a completed 2xx request as delivered", () => {
    expect(
      classifyCollectSettlement({ settledBy: "requestfinished", responseStatus: 204 }),
    ).toBe("finished");
  });

  it("fails a request that never received a GA4 response", () => {
    for (const failureText of [BEACON_POST_RESPONSE_ABORT, "net::ERR_BLOCKED_BY_CLIENT"]) {
      expect(
        classifyCollectSettlement({ settledBy: "requestfailed", responseStatus: 0, failureText }),
      ).toBe("failed");
    }
  });

  it("fails a non-2xx GA4 response", () => {
    for (const status of [400, 403, 500, 503]) {
      expect(
        classifyCollectSettlement({ settledBy: "requestfinished", responseStatus: status }),
      ).toBe("failed");
      expect(
        classifyCollectSettlement({
          settledBy: "requestfailed",
          responseStatus: status,
          failureText: BEACON_POST_RESPONSE_ABORT,
        }),
      ).toBe("failed");
    }
  });

  it("fails any failure other than the post-response beacon abort", () => {
    expect(
      classifyCollectSettlement({
        settledBy: "requestfailed",
        responseStatus: 204,
        failureText: "net::ERR_CONNECTION_RESET",
      }),
    ).toBe("failed");
  });
});

describe("UAT analytics smoke delivery contract", () => {
  it.each([false, true])("uses canonical read-only admission without suppressing real analytics (reverse init order: %s)", async reverse => {
    const initializers: { callback: (argument: unknown) => unknown; argument: unknown }[] = [];
    const page = { addInitScript: async (callback: (argument: unknown) => unknown, argument: unknown) => {
      initializers.push({ callback, argument });
    } };
    const start = SMOKE.indexOf("async function installAnalyticsCapture(page)");
    const end = SMOKE.indexOf("async function getSmokeState(page)", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    await runInNewContext(`${SMOKE.slice(start, end)}; installAnalyticsCapture(page)`, {
      page, installReviewerBridge, smokeUserId: "synthetic-reviewer", reviewerPassphrase: "synthetic-memory-only",
      appOrigin: "https://uat.one.hushh.ai",
    });
    expect(initializers.some(item => item.callback === installReviewerBridge)).toBe(true);
    const rejectPersistence = () => { throw new Error("Reviewer admission must remain memory-only"); };
    const isolatedWindow = { __HUSHH_NATIVE_TEST__: { enabled: false, retained: true },
      localStorage: { setItem: rejectPersistence }, sessionStorage: { setItem: rejectPersistence } };
    for (const { callback, argument } of reverse ? [...initializers].reverse() : initializers) {
      runInNewContext(`(${callback.toString()})(argument)`, { window: isolatedWindow, argument,
        localStorage: isolatedWindow.localStorage, sessionStorage: isolatedWindow.sessionStorage });
    }
    expect(isolatedWindow.__HUSHH_NATIVE_TEST__).toMatchObject({ retained: true, enabled: true,
      autoReviewerLogin: true, expectedUserId: "synthetic-reviewer", reviewerMutationPolicy: "read_only",
      vaultPassphrase: "synthetic-memory-only", reviewerSessionPassphrase: "synthetic-memory-only",
      allowUatAnalyticsSmokeTelemetry: true });
    const previous = window.__HUSHH_NATIVE_TEST__;
    try {
      window.__HUSHH_NATIVE_TEST__ = isolatedWindow.__HUSHH_NATIVE_TEST__;
      expect(shouldSkipReviewerBackgroundWritesForAutomation()).toBe(true);
      expect(shouldDisableExternalTelemetryForAutomation(undefined, "uat.one.hushh.ai")).toBe(false);
      expect(shouldDisableExternalTelemetryForAutomation(undefined, "production.example")).toBe(true);
      // The previous analytics bridge unlocked but did not declare read-only admission.
      window.__HUSHH_NATIVE_TEST__ = { enabled: true, autoReviewerLogin: true,
        expectedUserId: "synthetic-reviewer", vaultPassphrase: "synthetic-memory-only",
        allowUatAnalyticsSmokeTelemetry: true };
      expect(shouldSkipReviewerBackgroundWritesForAutomation()).toBe(false);
    } finally { window.__HUSHH_NATIVE_TEST__ = previous; }
  });

  it("reports only closed journey states and booleans when private values reach diagnostics", async () => {
    const page = { evaluate: (callback: (argument: unknown) => unknown, argument: unknown) =>
      runInNewContext(`(${callback.toString()})(argument)`, { argument, URLSearchParams,
        window: { location: { pathname: "/people/private-person", search: "?tab=private-tab&token=private-token" },
          __HUSHH_NATIVE_TEST__: { bootstrapState: "private-error-detail", bootstrapUserId: "private-owner",
            vaultPassphrase: "private-passphrase", reviewerMutationPolicy: "read_only" } },
        document: { querySelector: () => null, body: { textContent: "Private holdings and account details" } },
      }) };
    const diagnostic = await getSafeJourneyState(page, "synthetic-reviewer");
    expect(diagnostic).toEqual({ route: "other", tab: "other", bootstrapState: "other", bootstrapOwnerMatches: false,
      readOnly: true, financeWorkspacePresent: false, portfolioPanelActive: false, portfolioOverviewPresent: false,
      portfolioImportPresent: false, accountLoadingPresent: false, sessionVerificationPresent: false,
      registrationRecoveryPresent: false, vaultUnlockPresent: false, readinessMessage: "none", kaiPlacement: "none" });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-|holdings|account details/i);
  });

  it("identifies a withheld session without exporting page text or unknown placement", async () => {
    const page = { evaluate: (callback: (argument: unknown) => unknown, argument: unknown) =>
      runInNewContext(`(${callback.toString()})(argument)`, { argument, URLSearchParams,
        window: { location: { pathname: "/one/kai", search: "?tab=portfolio" } },
        document: { querySelector: (selector: string) => selector === "#session-verification-title" ? {} :
          selector === "[data-kai-placement]" ? { getAttribute: () => "private-owner-detail" } : null,
          body: { textContent: "Checking secure session… private-account-secret" } },
      }) };
    const diagnostic = await getSafeJourneyState(page, "synthetic-reviewer");
    expect(diagnostic).toMatchObject({ sessionVerificationPresent: true, readinessMessage: "Checking secure session", kaiPlacement: "none" });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-|account-secret/);
  });

  it("classifies requestfailed collect hits by their GA4 response", () => {
    expect(SMOKE).toContain('from "./analytics-collect-delivery.mjs"');
    const failureHandler = SMOKE.slice(
      SMOKE.indexOf("async function recordCollectRequestFailure"),
      SMOKE.indexOf('page.on("requestfailed"'),
    );
    expect(failureHandler).toContain("await request.response().catch(() => null)");
    expect(failureHandler).toContain('settledBy: "requestfailed"');
    expect(failureHandler).toContain("classifyCollectSettlement({");
    expect(SMOKE).toContain("void recordCollectRequestFailure(request);");
  });

  it("proves delivery from Node-side records that survive navigations", () => {
    expect(SMOKE).not.toContain("__HUSHH_ANALYTICS_COLLECT_EVENTS__");
    expect(SMOKE).toContain(
      "!isCollectEventDelivered(analyticsCollectEvents, requiredEvent)",
    );
  });

  it("waits for the login redirect before the first in-app navigation", () => {
    // Navigating first let the late /kai -> /one/kai?tab=market redirect
    // overwrite /one/kai?tab=portfolio and time the gate out.
    expect(SMOKE).toContain('const loginRedirectLandingPath = "/one/kai";');
    const bootstrap = SMOKE.indexOf("await waitForReviewerVaultBootstrap(page);");
    const settle = SMOKE.indexOf("await waitForLoginRedirectToSettle(page);");
    const navigate = SMOKE.indexOf('await navigateInApp(page, "/one/kai?tab=portfolio");');
    expect(bootstrap).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(bootstrap);
    expect(navigate).toBeGreaterThan(settle);
  });
});

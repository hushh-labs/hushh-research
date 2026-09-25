import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BEACON_POST_RESPONSE_ABORT,
  classifyCollectSettlement,
} from "../../scripts/testing/analytics-collect-delivery.mjs";

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

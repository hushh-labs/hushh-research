import { describe, expect, it } from "vitest";

import {
  BEACON_POST_RESPONSE_ABORT,
  classifyCollectSettlement,
  isCollectEventDelivered,
  undeliveredCollectEvents,
} from "../../scripts/testing/analytics-collect-delivery.mjs";

const TID = "G-H1KGXGZTCF";
const PAGE_VIEW = { eventName: "page_view", params: { route_id: "kai_home" } };

function settle(
  requestId: string,
  settledBy: "requestfinished" | "requestfailed",
  responseStatus: number,
  failureText?: string,
  overrides: Record<string, string> = {},
) {
  return {
    measurementId: TID,
    eventName: "page_view",
    route_id: "kai_home",
    requestId,
    httpStatus: responseStatus,
    failureText,
    status: classifyCollectSettlement({ settledBy, responseStatus, failureText }),
    ...overrides,
  };
}

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
    expect(
      classifyCollectSettlement({
        settledBy: "requestfailed",
        responseStatus: 0,
        failureText: BEACON_POST_RESPONSE_ABORT,
      }),
    ).toBe("failed");
    expect(
      classifyCollectSettlement({
        settledBy: "requestfailed",
        responseStatus: 0,
        failureText: "net::ERR_BLOCKED_BY_CLIENT",
      }),
    ).toBe("failed");
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

describe("isCollectEventDelivered", () => {
  it("proves delivery for the live beacon pattern", () => {
    const entries = [
      { ...settle("ga-1", "requestfailed", 204, BEACON_POST_RESPONSE_ABORT), status: "requested" },
      settle("ga-1", "requestfailed", 204, BEACON_POST_RESPONSE_ABORT),
    ];
    expect(isCollectEventDelivered(entries, TID, PAGE_VIEW)).toBe(true);
  });

  it("rejects a request that was also recorded as a real failure", () => {
    const entries = [
      settle("ga-1", "requestfinished", 204),
      settle("ga-1", "requestfailed", 0, "net::ERR_FAILED"),
    ];
    expect(isCollectEventDelivered(entries, TID, PAGE_VIEW)).toBe(false);
  });

  it("requires the matching measurement ID and params", () => {
    const delivered = settle("ga-1", "requestfinished", 204);
    expect(isCollectEventDelivered([delivered], "G-OTHER", PAGE_VIEW)).toBe(false);
    expect(
      isCollectEventDelivered(
        [settle("ga-1", "requestfinished", 204, undefined, { route_id: "login" })],
        TID,
        PAGE_VIEW,
      ),
    ).toBe(false);
  });

  it("does not count a request that is only in flight", () => {
    expect(
      isCollectEventDelivered(
        [{ ...settle("ga-1", "requestfinished", 204), status: "requested" }],
        TID,
        PAGE_VIEW,
      ),
    ).toBe(false);
  });
});

describe("undeliveredCollectEvents", () => {
  it("names exactly the events GA4 has not acknowledged", () => {
    const portfolio = {
      eventName: "portfolio_viewed",
      params: { result: "success", portfolio_source: "statement" },
    };
    const entries = [settle("ga-1", "requestfailed", 204, BEACON_POST_RESPONSE_ABORT)];
    expect(undeliveredCollectEvents(entries, TID, [PAGE_VIEW, portfolio])).toEqual([portfolio]);
  });
});

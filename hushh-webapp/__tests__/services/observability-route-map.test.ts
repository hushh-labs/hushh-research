import { describe, expect, it } from "vitest";

import {
  normalizeApiPathToTemplate,
  resolveRouteId,
} from "@/lib/observability/route-map";

describe("observability route map", () => {
  it("maps canonical app routes to stable route IDs", () => {
    expect(resolveRouteId("/kai")).toBe("kai_home");
    expect(resolveRouteId("/kai/dashboard")).toBe("kai_dashboard_legacy_redirect");
    expect(resolveRouteId("/kai/dashboard/analysis")).toBe("kai_dashboard_legacy_redirect");
    expect(resolveRouteId("/marketplace")).toBe("marketplace");
    expect(resolveRouteId("/marketplace/ria")).toBe("marketplace_ria_profile");
    expect(resolveRouteId("/ria/clients")).toBe("ria_clients");
    expect(resolveRouteId("/ria/clients/user_123")).toBe("ria_workspace");
    expect(resolveRouteId("/ria/clients/user_123/accounts/account_456")).toBe("ria_workspace");
    expect(resolveRouteId("/ria/clients/user_123/requests/request_789")).toBe("ria_workspace");
    expect(resolveRouteId("/ria/workspace")).toBe("ria_workspace");
    expect(resolveRouteId("/kai/funding-trade")).toBe("kai_funding_trade");
    expect(resolveRouteId("/unknown/path")).toBe("unknown");
  });

  it("normalizes known API endpoint templates", () => {
    expect(normalizeApiPathToTemplate("/api/kai/market/insights/baseline/user_123")).toBe(
      "/api/kai/market/insights/baseline/{user_id}"
    );
    expect(normalizeApiPathToTemplate("/api/kai/market/insights/user_123")).toBe(
      "/api/kai/market/insights/{user_id}"
    );
    expect(normalizeApiPathToTemplate("/api/kai/analyze/run/run_987/stream?cursor=0")).toBe(
      "/api/kai/analyze/run/{run_id}/stream"
    );
    expect(normalizeApiPathToTemplate("/api/vault/get?userId=test")).toBe(
      "/db/vault/get"
    );
    expect(normalizeApiPathToTemplate("/api/ria/workspace/user_123")).toBe(
      "/api/ria/workspace/{investor_user_id}"
    );
    expect(normalizeApiPathToTemplate("/api/kai/plaid/trades/funded/create")).toBe(
      "/api/kai/plaid/trades/funded/create"
    );
    expect(normalizeApiPathToTemplate("/api/kai/plaid/trades/funded/intent_123/refresh")).toBe(
      "/api/kai/plaid/trades/funded/{intent_id}/refresh"
    );
    expect(normalizeApiPathToTemplate("/api/consent/center?actor=ria&view=outgoing")).toBe(
      "/api/consent/center"
    );
  });

  it("redacts opaque IDs for unknown endpoints", () => {
    expect(
      normalizeApiPathToTemplate("/api/custom/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/details")
    ).toBe("/api/custom/{id}/details");
  });
});

import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  normalizeApiPathToTemplate,
  resolveRouteId,
} from "@/lib/observability/route-map";

const DYNAMIC_SEGMENT_SAMPLES: Record<string, string> = {
  userId: "sample_user",
  accountId: "sample_account",
  requestId: "sample_request",
};

function collectAppPageRoutes(dir: string, root: string = dir): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      routes.push(...collectAppPageRoutes(fullPath, root));
      continue;
    }
    if (entry !== "page.tsx") continue;

    const relativeDir = path.relative(root, path.dirname(fullPath));
    const segments = relativeDir
      ? relativeDir.split(path.sep).filter((segment) => !segment.startsWith("("))
      : [];
    const routeSegments = segments.map((segment) => {
      const dynamicMatch = segment.match(/^\[+\.{0,3}([^\]]+)\]+$/);
      if (!dynamicMatch) return segment;
      return DYNAMIC_SEGMENT_SAMPLES[dynamicMatch[1]!] || "sample";
    });
    routes.push(`/${routeSegments.join("/")}`.replace(/\/$/, "") || "/");
  }
  return routes.sort();
}

describe("observability route map", () => {
  it("maps canonical app routes to stable route IDs", () => {
    expect(resolveRouteId("/kai")).toBe("kai_home");
    expect(resolveRouteId("/kai/dashboard")).toBe("kai_dashboard_legacy_redirect");
    expect(resolveRouteId("/kai/dashboard/analysis")).toBe("kai_dashboard_legacy_redirect");
    expect(resolveRouteId("/marketplace")).toBe("marketplace");
    expect(resolveRouteId("/marketplace/connections")).toBe("marketplace_connections");
    expect(resolveRouteId("/marketplace/connections/portfolio")).toBe(
      "marketplace_connection_portfolio"
    );
    expect(resolveRouteId("/marketplace/ria")).toBe("marketplace_ria_profile");
    expect(resolveRouteId("/register-phone")).toBe("phone_mandate");
    expect(resolveRouteId("/profile/pkm")).toBe("profile_pkm");
    expect(resolveRouteId("/profile/pkm-agent-lab")).toBe("profile_pkm_agent_lab");
    expect(resolveRouteId("/profile/receipts")).toBe("profile_receipts");
    expect(resolveRouteId("/profile/gmail/oauth/return")).toBe("profile_gmail_oauth_return");
    expect(resolveRouteId("/portfolio/shared")).toBe("portfolio_shared");
    expect(resolveRouteId("/ria/clients")).toBe("ria_clients");
    expect(resolveRouteId("/ria/clients/user_123")).toBe("ria_workspace");
    expect(resolveRouteId("/ria/clients/user_123/accounts/account_456")).toBe("ria_workspace");
    expect(resolveRouteId("/ria/clients/user_123/requests/request_789")).toBe("ria_workspace");
    expect(resolveRouteId("/ria/picks")).toBe("ria_picks");
    expect(resolveRouteId("/ria/workspace")).toBe("ria_workspace");
    expect(resolveRouteId("/kai/plaid/oauth/return")).toBe("kai_plaid_oauth_return");
    expect(resolveRouteId("/kai/alpaca/oauth/return")).toBe("kai_alpaca_oauth_return");
    expect(resolveRouteId("/kai/funding-trade")).toBe("kai_funding_trade");
    expect(resolveRouteId("/unknown/path")).toBe("unknown");
  });

  it("maps every first-party app page to a non-unknown route ID", () => {
    const appDir = path.resolve(process.cwd(), "app");
    const routes = collectAppPageRoutes(appDir);
    const unknownRoutes = routes.filter((route) => resolveRouteId(route) === "unknown");

    expect(unknownRoutes).toEqual([]);
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

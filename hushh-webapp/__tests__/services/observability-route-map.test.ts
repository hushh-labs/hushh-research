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
      ? relativeDir
          .split(path.sep)
          .filter((segment) => !segment.startsWith("("))
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
    expect(resolveRouteId("/")).toBe("one_dashboard");
    expect(resolveRouteId("/one")).toBe("one_dashboard");
    expect(resolveRouteId("/welcome")).toBe("one_dashboard");
    expect(resolveRouteId("/one/gmail")).toBe("gmail");
    expect(resolveRouteId("/one/pkm")).toBe("pkm");
    expect(resolveRouteId("/one/connected-systems")).toBe("connected_systems");
    expect(
      resolveRouteId("/one/connected-systems/salesforce-fsc-customer0"),
    ).toBe("connected_systems");
    expect(resolveRouteId("/research")).toBe("research");
    expect(resolveRouteId("/research/protocol")).toBe("research_protocol");
    expect(resolveRouteId("/products/hushh-tech/launch")).toBe("hushh_tech_launch");
    expect(resolveRouteId("/blog")).toBe("blog");
    expect(resolveRouteId("/blog/sample")).toBe("blog_post");
    expect(resolveRouteId("/gmail")).toBe("gmail");
    expect(resolveRouteId("/pkm")).toBe("pkm");
    expect(resolveRouteId("/connected-systems")).toBe("connected_systems");
    expect(resolveRouteId("/one/kai")).toBe("kai_home");
    expect(resolveRouteId("/one/kai/market")).toBe("kai_home");
    expect(resolveRouteId("/one/kai/news")).toBe("kai_market_news");
    expect(resolveRouteId("/kai")).toBe("kai_home");
    expect(resolveRouteId("/kai/dashboard")).toBe(
      "kai_dashboard_legacy_redirect",
    );
    expect(resolveRouteId("/kai/dashboard/analysis")).toBe(
      "kai_dashboard_legacy_redirect",
    );
    expect(resolveRouteId("/marketplace")).toBe("marketplace");
    expect(resolveRouteId("/marketplace/connections")).toBe(
      "marketplace_connections",
    );
    expect(resolveRouteId("/marketplace/connections/portfolio")).toBe(
      "marketplace_connection_portfolio",
    );
    expect(resolveRouteId("/marketplace/ria")).toBe("marketplace_ria_profile");
    expect(resolveRouteId("/register-phone")).toBe("phone_mandate");
    expect(resolveRouteId("/one/profile/regulatory")).toBe(
      "profile_regulatory",
    );
    expect(resolveRouteId("/one/profile/security/devices")).toBe(
      "profile_security_devices",
    );
    expect(resolveRouteId("/one/profile/security/devices/authorize")).toBe(
      "profile_security_device_authorize",
    );
    expect(resolveRouteId("/one/profile/pkm")).toBe("profile_pkm");
    expect(resolveRouteId("/one/profile/pkm-agent-lab")).toBe(
      "profile_pkm_agent_lab",
    );
    expect(resolveRouteId("/one/profile/receipts")).toBe("profile_receipts");
    expect(resolveRouteId("/one/profile/gmail/oauth/return")).toBe(
      "profile_gmail_oauth_return",
    );
    expect(resolveRouteId("/oauth/authorize")).toBe("oauth_authorize");
    expect(resolveRouteId("/one/location")).toBe("one_location");
    expect(resolveRouteId("/one/location/map")).toBe("one_location_map");
    expect(resolveRouteId("/one/location/view/sample")).toBe(
      "one_location_public_request",
    );
    expect(resolveRouteId("/one/location/invite/sample")).toBe(
      "one_location_circle_invite",
    );
    expect(resolveRouteId("/one/wallet-card")).toBe("one_wallet_card");
    // The public Wallet Profile emits no analytics, but it still needs a
    // stable ID: "unknown" is the branch that would otherwise carry the raw
    // pathname — and here the pathname is the share token.
    expect(resolveRouteId("/c")).toBe("wallet_card_public");
    expect(resolveRouteId("/c/tok_abc123")).toBe("wallet_card_public");
    // Must not swallow an unrelated sibling.
    expect(resolveRouteId("/consents")).toBe("consents");
    expect(resolveRouteId("/agent")).toBe("agent");
    expect(resolveRouteId("/one/connect/settings")).toBe("connect_settings");
    expect(resolveRouteId("/one/profile/preferences/gemini")).toBe(
      "profile_preferences_gemini",
    );
    expect(resolveRouteId("/one/profile/preferences/voice")).toBe(
      "profile_preferences_voice",
    );
    expect(resolveRouteId("/one/profile/preferences/voice/changelog")).toBe(
      "profile_preferences_voice_changelog",
    );
    expect(resolveRouteId("/portfolio/shared")).toBe("portfolio_shared");
    expect(resolveRouteId("/ria/clients")).toBe("ria_clients");
    expect(resolveRouteId("/ria/clients/user_123")).toBe("ria_workspace");
    expect(resolveRouteId("/ria/clients/user_123/accounts/account_456")).toBe(
      "ria_workspace",
    );
    expect(resolveRouteId("/ria/clients/user_123/requests/request_789")).toBe(
      "ria_workspace",
    );
    expect(resolveRouteId("/ria/picks")).toBe("ria_picks");
    expect(resolveRouteId("/ria/workspace")).toBe("ria_workspace");
    expect(resolveRouteId("/ria/profile")).toBe("profile_regulatory");
    expect(resolveRouteId("/one/kai/plaid/oauth/return")).toBe(
      "kai_plaid_oauth_return",
    );
    expect(resolveRouteId("/one/kai/alpaca/oauth/return")).toBe(
      "kai_alpaca_oauth_return",
    );
    expect(resolveRouteId("/one/kai/funding-trade")).toBe(
      "kai_dashboard_legacy_redirect",
    );
    expect(resolveRouteId("/unknown/path")).toBe("unknown");
  });

  it("maps every first-party app page to a non-unknown route ID", () => {
    const appDir = path.resolve(process.cwd(), "app");
    const routes = collectAppPageRoutes(appDir);
    const unknownRoutes = routes.filter(
      (route) => resolveRouteId(route) === "unknown",
    );

    expect(unknownRoutes).toEqual([]);
  });

  it("normalizes known API endpoint templates", () => {
    expect(
      normalizeApiPathToTemplate("/api/kai/market/insights/baseline/user_123"),
    ).toBe("/api/kai/market/insights/baseline/{user_id}");
    expect(
      normalizeApiPathToTemplate("/api/kai/market/insights/user_123"),
    ).toBe("/api/kai/market/insights/{user_id}");
    expect(
      normalizeApiPathToTemplate("/api/kai/market/news/baseline/user_123"),
    ).toBe("/api/kai/market/news/baseline/{user_id}");
    expect(normalizeApiPathToTemplate("/api/kai/market/news/user_123")).toBe(
      "/api/kai/market/news/{user_id}",
    );
    expect(normalizeApiPathToTemplate("/api/kai/agent/chat/stream")).toBe(
      "/api/kai/agent/chat/stream",
    );
    expect(
      normalizeApiPathToTemplate(
        "/api/kai/agent/chat/conversations/user_123?limit=1",
      ),
    ).toBe("/api/kai/agent/chat/conversations/{user_id}");
    expect(
      normalizeApiPathToTemplate(
        "/api/kai/agent/chat/history/conversation_123",
      ),
    ).toBe("/api/kai/agent/chat/history/{conversation_id}");
    expect(
      normalizeApiPathToTemplate(
        "/api/kai/analyze/run/run_987/stream?cursor=0",
      ),
    ).toBe("/api/kai/analyze/run/{run_id}/stream");
    expect(normalizeApiPathToTemplate("/api/vault/get?userId=test")).toBe(
      "/db/vault/get",
    );
    expect(normalizeApiPathToTemplate("/api/ria/workspace/user_123")).toBe(
      "/api/ria/workspace/{investor_user_id}",
    );
    expect(
      normalizeApiPathToTemplate("/api/kai/plaid/trades/funded/create"),
    ).toBe("/api/kai/plaid/trades/funded/create");
    expect(
      normalizeApiPathToTemplate(
        "/api/kai/plaid/trades/funded/intent_123/refresh",
      ),
    ).toBe("/api/kai/plaid/trades/funded/{intent_id}/refresh");
    expect(
      normalizeApiPathToTemplate("/api/consent/center?actor=ria&view=outgoing"),
    ).toBe("/api/consent/center");
    expect(
      normalizeApiPathToTemplate("/api/one/kyc/workflows/wf_123/redraft"),
    ).toBe("/api/one/kyc/workflows/{workflow_id}/redraft");
    expect(
      normalizeApiPathToTemplate("/api/one/location/grants/grant_123/envelope"),
    ).toBe("/api/one/location/grants/{grant_id}/envelope");
    expect(
      normalizeApiPathToTemplate(
        "/api/one/location/public-invites/public_token_123/submit",
      ),
    ).toBe("/api/one/location/public-invites/{public_token}/submit");
    expect(normalizeApiPathToTemplate("/api/connected-systems")).toBe(
      "/api/connected-systems",
    );
    expect(
      normalizeApiPathToTemplate(
        "/api/connected-systems/salesforce-fsc-customer0/schema?objectType=Contact",
      ),
    ).toBe("/api/connected-systems/{system_id}/schema");
    expect(
      normalizeApiPathToTemplate(
        "/api/connected-systems/salesforce-fsc-customer0/records/read",
      ),
    ).toBe("/api/connected-systems/{system_id}/records/read");
    expect(
      normalizeApiPathToTemplate(
        "/api/connected-systems/salesforce-fsc-customer0/intents/csi_1234567890/approve",
      ),
    ).toBe("/api/connected-systems/{system_id}/intents/{intent_id}/approve");
  });

  it("redacts opaque IDs for unknown endpoints", () => {
    expect(
      normalizeApiPathToTemplate(
        "/api/custom/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/details",
      ),
    ).toBe("/api/custom/{id}/details");
  });
  it("preserves fail-closed handling for uppercase route variants", () => {
    expect(resolveRouteId("/KAI/PORTFOLIO")).toBe("unknown");
  });
});

/**
 * The native build sets `trailingSlash: true` (next.config.ts, gated on
 * isCapacitorBuild), so every iOS and Android route arrives with a trailing
 * slash. Before these cases, that meant essentially every native screen
 * reported as "unknown" -- 117 iOS users and 7,504 views in 30 days -- while
 * the handful of routes matched by a `startsWith(".../")` prefix looked fine,
 * which is what made it survive so long.
 */
describe("route ids from the native (trailing-slash) build", () => {
  it("resolves every first-party route in its native trailing-slash form", () => {
    // Derived from the route tree rather than a hand-written list, so a route
    // added later with a `startsWith(".../")` prefix cannot regress on
    // iOS/Android unnoticed -- which is exactly how `/ria/clients/` came to
    // report the per-client workspace id for the clients list screen.
    const appDir = path.resolve(process.cwd(), "app");
    for (const route of collectAppPageRoutes(appDir)) {
      const web = route.replace(/\[[^\]]+\]/g, "sample");
      const native = web === "/" ? "/" : `${web}/`;
      expect(resolveRouteId(native)).toBe(resolveRouteId(web));
      expect(resolveRouteId(native)).not.toBe("unknown");
    }
  });

  it("treats a static-export index document as its directory route", () => {
    expect(resolveRouteId("/one/location/index.html")).toBe(
      resolveRouteId("/one/location"),
    );
    expect(resolveRouteId("/index.html")).toBe(resolveRouteId("/"));
  });

  it("does not mistake the blog index for a post on native", () => {
    // "/blog/" previously matched startsWith("/blog/") and reported the index
    // as a post, so this was wrong rather than merely missing.
    expect(resolveRouteId("/blog/")).toBe("blog");
    expect(resolveRouteId("/blog/some-post/")).toBe("blog_post");
  });

  it("still resolves token routes, which must never fall through", () => {
    // Falling through logs the raw pathname, and on these routes the pathname
    // carries the token.
    expect(resolveRouteId("/one/location/view/abc123/")).toBe(
      "one_location_public_request",
    );
    // The pre-rename path still resolves to the SAME id: it is one screen,
    // and splitting it would break every dashboard reading this route at the
    // moment of the rename.
    expect(resolveRouteId("/one/location/request/abc123/")).toBe(
      "one_location_public_request",
    );
    expect(resolveRouteId("/one/location/invite/abc123/")).toBe(
      "one_location_circle_invite",
    );
    expect(resolveRouteId("/circle/join/")).toBe("one_location_circle_join");
    expect(resolveRouteId("/c/abc123/")).toBe("wallet_card_public");
  });

  it("degrades a full href to its route rather than to unknown", () => {
    expect(resolveRouteId("/one/location?action=share")).toBe("one_location");
    expect(resolveRouteId("/one/location/#people")).toBe("one_location");
  });

  it("keeps empty and root pathnames on the dashboard", () => {
    expect(resolveRouteId("")).toBe(resolveRouteId("/"));
  });
});

import { ROUTES } from "@/lib/navigation/routes";

export const ROUTE_ID_VALUES = [
  "landing",
  "developers",
  "login",
  "logout",
  "labs_profile_appearance",
  "profile",
  "consents",
  "marketplace",
  "marketplace_ria_profile",
  "ria_home",
  "ria_onboarding",
  "ria_clients",
  "ria_requests",
  "ria_settings",
  "ria_workspace",
  "kai_home",
  "kai_onboarding",
  "kai_import",
  "kai_dashboard",
  "kai_investments",
  "kai_funding_trade",
  "kai_analysis",
  "kai_optimize",
  "kai_dashboard_legacy_redirect",
  "unknown",
] as const;

export type RouteId = (typeof ROUTE_ID_VALUES)[number];

export function resolveRouteId(pathname: string): RouteId {
  if (pathname === ROUTES.HOME) return "landing";
  if (pathname === ROUTES.DEVELOPERS) return "developers";
  if (pathname === ROUTES.LOGIN) return "login";
  if (pathname === ROUTES.LOGOUT) return "logout";
  if (pathname === ROUTES.LABS_PROFILE_APPEARANCE) return "labs_profile_appearance";
  if (pathname === ROUTES.PROFILE) return "profile";
  if (pathname === ROUTES.CONSENTS) return "consents";
  if (pathname === ROUTES.MARKETPLACE) return "marketplace";
  if (
    pathname === ROUTES.MARKETPLACE_RIA_PROFILE ||
    pathname.startsWith(`${ROUTES.MARKETPLACE_RIA_PROFILE}/`)
  ) {
    return "marketplace_ria_profile";
  }
  if (pathname === ROUTES.RIA_HOME) return "ria_home";
  if (pathname === ROUTES.RIA_ONBOARDING) return "ria_onboarding";
  if (pathname === ROUTES.RIA_CLIENTS) return "ria_clients";
  if (pathname === ROUTES.RIA_REQUESTS) return "ria_requests";
  if (pathname === ROUTES.RIA_SETTINGS) return "ria_settings";
  if (
    pathname === ROUTES.RIA_WORKSPACE ||
    pathname.startsWith(`${ROUTES.RIA_HOME}/workspace/`) ||
    pathname.startsWith(`${ROUTES.RIA_CLIENTS}/`)
  ) {
    return "ria_workspace";
  }
  if (pathname === ROUTES.KAI_HOME) return "kai_home";
  if (pathname === ROUTES.KAI_ONBOARDING) return "kai_onboarding";
  if (pathname === ROUTES.KAI_IMPORT) return "kai_import";
  if (pathname === ROUTES.KAI_DASHBOARD) return "kai_dashboard";
  if (pathname === ROUTES.KAI_INVESTMENTS) return "kai_investments";
  if (pathname === ROUTES.KAI_FUNDING_TRADE) return "kai_funding_trade";
  if (pathname === ROUTES.KAI_ANALYSIS) return "kai_analysis";
  if (pathname === ROUTES.KAI_OPTIMIZE) return "kai_optimize";
  if (pathname === "/kai/dashboard") return "kai_dashboard_legacy_redirect";

  if (pathname.startsWith(`${ROUTES.KAI_DASHBOARD}/`)) {
    return "kai_dashboard_legacy_redirect";
  }
  if (pathname.startsWith("/kai/dashboard/")) {
    return "kai_dashboard_legacy_redirect";
  }

  return "unknown";
}

const API_TEMPLATE_RULES: Array<{ regex: RegExp; template: string }> = [
  { regex: /^\/api\/vault\/check(?:\?.*)?$/i, template: "/db/vault/check" },
  { regex: /^\/api\/vault\/get(?:\?.*)?$/i, template: "/db/vault/get" },
  {
    regex: /^\/api\/vault\/bootstrap-state(?:\?.*)?$/i,
    template: "/db/vault/bootstrap-state",
  },
  {
    regex: /^\/api\/pkm\/metadata\/[^/?]+(?:\?.*)?$/i,
    template: "/api/pkm/metadata/{user_id}",
  },
  {
    regex: /^\/api\/pkm\/scopes\/[^/?]+(?:\?.*)?$/i,
    template: "/api/pkm/scopes/{user_id}",
  },
  {
    regex: /^\/api\/pkm\/data\/[^/?]+(?:\?.*)?$/i,
    template: "/api/pkm/data/{user_id}",
  },
  {
    regex: /^\/api\/pkm\/domain-data\/[^/?]+\/[^/?]+(?:\?.*)?$/i,
    template: "/api/pkm/domain-data/{user_id}/{domain}",
  },
  {
    regex: /^\/api\/kai\/market\/insights\/baseline\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/market/insights/baseline/{user_id}",
  },
  {
    regex: /^\/api\/kai\/market\/insights\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/market/insights/{user_id}",
  },
  {
    regex: /^\/api\/kai\/dashboard\/profile-picks\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/dashboard/profile-picks/{user_id}",
  },
  {
    regex: /^\/api\/kai\/portfolio\/summary\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/portfolio/summary/{user_id}",
  },
  {
    regex: /^\/api\/kai\/plaid\/status\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/plaid/status/{user_id}",
  },
  {
    regex: /^\/api\/kai\/plaid\/link-token(?:\?.*)?$/i,
    template: "/api/kai/plaid/link-token",
  },
  {
    regex: /^\/api\/kai\/plaid\/link-token\/update(?:\?.*)?$/i,
    template: "/api/kai/plaid/link-token/update",
  },
  {
    regex: /^\/api\/kai\/plaid\/oauth\/resume(?:\?.*)?$/i,
    template: "/api/kai/plaid/oauth/resume",
  },
  {
    regex: /^\/api\/kai\/plaid\/exchange-public-token(?:\?.*)?$/i,
    template: "/api/kai/plaid/exchange-public-token",
  },
  {
    regex: /^\/api\/kai\/plaid\/funding\/link-token(?:\?.*)?$/i,
    template: "/api/kai/plaid/funding/link-token",
  },
  {
    regex: /^\/api\/kai\/plaid\/funding\/exchange-public-token(?:\?.*)?$/i,
    template: "/api/kai/plaid/funding/exchange-public-token",
  },
  {
    regex: /^\/api\/kai\/plaid\/funding\/status\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/plaid/funding/status/{user_id}",
  },
  {
    regex: /^\/api\/kai\/plaid\/funding\/transactions\/sync(?:\?.*)?$/i,
    template: "/api/kai/plaid/funding/transactions/sync",
  },
  {
    regex: /^\/api\/kai\/plaid\/funding\/default-account(?:\?.*)?$/i,
    template: "/api/kai/plaid/funding/default-account",
  },
  {
    regex: /^\/api\/kai\/plaid\/funding\/admin\/search(?:\?.*)?$/i,
    template: "/api/kai/plaid/funding/admin/search",
  },
  {
    regex: /^\/api\/kai\/plaid\/funding\/admin\/escalations(?:\?.*)?$/i,
    template: "/api/kai/plaid/funding/admin/escalations",
  },
  {
    regex: /^\/api\/kai\/plaid\/funding\/admin\/transfers\/[^/?]+\/refresh(?:\?.*)?$/i,
    template: "/api/kai/plaid/funding/admin/transfers/{transfer_id}/refresh",
  },
  {
    regex: /^\/api\/kai\/plaid\/funding\/reconcile(?:\?.*)?$/i,
    template: "/api/kai/plaid/funding/reconcile",
  },
  {
    regex: /^\/api\/kai\/alpaca\/connect\/start(?:\?.*)?$/i,
    template: "/api/kai/alpaca/connect/start",
  },
  {
    regex: /^\/api\/kai\/alpaca\/connect\/complete(?:\?.*)?$/i,
    template: "/api/kai/alpaca/connect/complete",
  },
  {
    regex: /^\/api\/kai\/plaid\/transfers\/create(?:\?.*)?$/i,
    template: "/api/kai/plaid/transfers/create",
  },
  {
    regex: /^\/api\/kai\/plaid\/trades\/funded\/create(?:\?.*)?$/i,
    template: "/api/kai/plaid/trades/funded/create",
  },
  {
    regex: /^\/api\/kai\/plaid\/trades\/funded(?:\?.*)?$/i,
    template: "/api/kai/plaid/trades/funded",
  },
  {
    regex: /^\/api\/kai\/plaid\/trades\/funded\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/plaid/trades/funded/{intent_id}",
  },
  {
    regex: /^\/api\/kai\/plaid\/trades\/funded\/[^/?]+\/refresh(?:\?.*)?$/i,
    template: "/api/kai/plaid/trades/funded/{intent_id}/refresh",
  },
  {
    regex: /^\/api\/kai\/plaid\/transfers\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/plaid/transfers/{transfer_id}",
  },
  {
    regex: /^\/api\/kai\/plaid\/transfers\/[^/?]+\/cancel(?:\?.*)?$/i,
    template: "/api/kai/plaid/transfers/{transfer_id}/cancel",
  },
  {
    regex: /^\/api\/kai\/plaid\/refresh(?:\?.*)?$/i,
    template: "/api/kai/plaid/refresh",
  },
  {
    regex: /^\/api\/kai\/plaid\/refresh\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/plaid/refresh/{run_id}",
  },
  {
    regex: /^\/api\/kai\/plaid\/refresh\/[^/?]+\/cancel(?:\?.*)?$/i,
    template: "/api/kai/plaid/refresh/{run_id}/cancel",
  },
  {
    regex: /^\/api\/kai\/plaid\/source(?:\?.*)?$/i,
    template: "/api/kai/plaid/source",
  },
  {
    regex: /^\/api\/kai\/gmail\/connect\/start(?:\?.*)?$/i,
    template: "/api/kai/gmail/connect/start",
  },
  {
    regex: /^\/api\/kai\/gmail\/connect\/complete(?:\?.*)?$/i,
    template: "/api/kai/gmail/connect/complete",
  },
  {
    regex: /^\/api\/kai\/gmail\/status\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/gmail/status/{user_id}",
  },
  {
    regex: /^\/api\/kai\/gmail\/disconnect(?:\?.*)?$/i,
    template: "/api/kai/gmail/disconnect",
  },
  {
    regex: /^\/api\/kai\/gmail\/reconcile(?:\?.*)?$/i,
    template: "/api/kai/gmail/reconcile",
  },
  {
    regex: /^\/api\/kai\/gmail\/sync(?:\?.*)?$/i,
    template: "/api/kai/gmail/sync",
  },
  {
    regex: /^\/api\/kai\/gmail\/sync\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/gmail/sync/{run_id}",
  },
  {
    regex: /^\/api\/kai\/gmail\/receipts\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/gmail/receipts/{user_id}",
  },
  {
    regex: /^\/api\/kai\/gmail\/receipts-memory\/preview(?:\?.*)?$/i,
    template: "/api/kai/gmail/receipts-memory/preview",
  },
  {
    regex: /^\/api\/kai\/gmail\/receipts-memory\/artifacts\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/gmail/receipts-memory/artifacts/{artifact_id}",
  },
  {
    regex: /^\/api\/kai\/analyze\/run\/start(?:\?.*)?$/i,
    template: "/api/kai/analyze/run/start",
  },
  {
    regex: /^\/api\/kai\/analyze\/run\/active(?:\?.*)?$/i,
    template: "/api/kai/analyze/run/active",
  },
  {
    regex: /^\/api\/kai\/analyze\/run\/[^/?]+\/stream(?:\?.*)?$/i,
    template: "/api/kai/analyze/run/{run_id}/stream",
  },
  {
    regex: /^\/api\/kai\/analyze\/run\/[^/?]+\/cancel(?:\?.*)?$/i,
    template: "/api/kai/analyze/run/{run_id}/cancel",
  },
  {
    regex: /^\/api\/kai\/portfolio\/import\/run\/start(?:\?.*)?$/i,
    template: "/api/kai/portfolio/import/run/start",
  },
  {
    regex: /^\/api\/kai\/portfolio\/import\/run\/active(?:\?.*)?$/i,
    template: "/api/kai/portfolio/import/run/active",
  },
  {
    regex: /^\/api\/kai\/portfolio\/import\/run\/[^/?]+\/stream(?:\?.*)?$/i,
    template: "/api/kai/portfolio/import/run/{run_id}/stream",
  },
  {
    regex: /^\/api\/kai\/portfolio\/import\/run\/[^/?]+\/cancel(?:\?.*)?$/i,
    template: "/api/kai/portfolio/import/run/{run_id}/cancel",
  },
  {
    regex: /^\/api\/consent\/pending(?:\?.*)?$/i,
    template: "/api/consent/pending",
  },
  {
    regex: /^\/api\/consent\/pending\/approve(?:\?.*)?$/i,
    template: "/api/consent/pending/approve",
  },
  {
    regex: /^\/api\/consent\/pending\/deny(?:\?.*)?$/i,
    template: "/api/consent/pending/deny",
  },
  {
    regex: /^\/api\/consent\/revoke(?:\?.*)?$/i,
    template: "/api/consent/revoke",
  },
  {
    regex: /^\/api\/consent\/center(?:\?.*)?$/i,
    template: "/api/consent/center",
  },
  {
    regex: /^\/api\/consent\/requests(?:\?.*)?$/i,
    template: "/api/consent/requests",
  },
  {
    regex: /^\/api\/consent\/requests\/outgoing(?:\?.*)?$/i,
    template: "/api/consent/requests/outgoing",
  },
  {
    regex: /^\/api\/account\/delete(?:\?.*)?$/i,
    template: "/api/account/delete",
  },
  {
    regex: /^\/api\/developer\/access(?:\?.*)?$/i,
    template: "/api/developer/access",
  },
  {
    regex: /^\/api\/developer\/access\/enable(?:\?.*)?$/i,
    template: "/api/developer/access/enable",
  },
  {
    regex: /^\/api\/developer\/access\/profile(?:\?.*)?$/i,
    template: "/api/developer/access/profile",
  },
  {
    regex: /^\/api\/developer\/access\/rotate-key(?:\?.*)?$/i,
    template: "/api/developer/access/rotate-key",
  },
  {
    regex: /^\/api\/iam\/persona(?:\?.*)?$/i,
    template: "/api/iam/persona",
  },
  {
    regex: /^\/api\/iam\/persona\/switch(?:\?.*)?$/i,
    template: "/api/iam/persona/switch",
  },
  {
    regex: /^\/api\/iam\/marketplace\/opt-in(?:\?.*)?$/i,
    template: "/api/iam/marketplace/opt-in",
  },
  {
    regex: /^\/api\/ria\/onboarding\/submit(?:\?.*)?$/i,
    template: "/api/ria/onboarding/submit",
  },
  {
    regex: /^\/api\/ria\/onboarding\/status(?:\?.*)?$/i,
    template: "/api/ria/onboarding/status",
  },
  {
    regex: /^\/api\/ria\/clients(?:\?.*)?$/i,
    template: "/api/ria/clients",
  },
  {
    regex: /^\/api\/ria\/invites(?:\?.*)?$/i,
    template: "/api/ria/invites",
  },
  {
    regex: /^\/api\/ria\/marketplace\/discoverability(?:\?.*)?$/i,
    template: "/api/ria/marketplace/discoverability",
  },
  {
    regex: /^\/api\/ria\/requests(?:\?.*)?$/i,
    template: "/api/ria/requests",
  },
  {
    regex: /^\/api\/ria\/workspace\/[^/?]+(?:\?.*)?$/i,
    template: "/api/ria/workspace/{investor_user_id}",
  },
  {
    regex: /^\/api\/marketplace\/rias(?:\?.*)?$/i,
    template: "/api/marketplace/rias",
  },
  {
    regex: /^\/api\/marketplace\/investors(?:\?.*)?$/i,
    template: "/api/marketplace/investors",
  },
  {
    regex: /^\/api\/marketplace\/ria\/[^/?]+(?:\?.*)?$/i,
    template: "/api/marketplace/ria/{ria_id}",
  },
  {
    regex: /^\/api\/invites\/[^/?]+(?:\?.*)?$/i,
    template: "/api/invites/{invite_token}",
  },
  {
    regex: /^\/api\/invites\/[^/?]+\/accept(?:\?.*)?$/i,
    template: "/api/invites/{invite_token}/accept",
  },
];

export function normalizeApiPathToTemplate(path: string): string {
  const withoutQuery = path.split("?")[0] || "/";

  for (const rule of API_TEMPLATE_RULES) {
    if (rule.regex.test(path)) {
      return rule.template;
    }
  }

  // Generic fallback: hide likely identifiers in dynamic path segments.
  const sanitized = withoutQuery
    .split("/")
    .map((segment, index) => {
      if (!segment || index === 0 || segment === "api" || segment === "db") {
        return segment;
      }

      const looksNumeric = /^\d+$/.test(segment);
      const looksUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          segment
        );
      const looksOpaqueId = /^[a-z0-9_-]{10,}$/i.test(segment);

      if (looksNumeric || looksUuid || looksOpaqueId) {
        return "{id}";
      }
      return segment;
    })
    .join("/");

  return sanitized || "/";
}

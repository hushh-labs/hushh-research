import {
  HUSHH_TECH_LAUNCH_PATH,
  KAI_MARKET_PATH,
  normalizeStaticExportPathname,
  ROUTES,
} from "@/lib/navigation/routes";

export const ROUTE_ID_VALUES = [
  "one_dashboard",
  "getting_started",
  "one_setup",
  "developers",
  "research",
  "research_protocol",
  "hushh_tech_launch",
  "blog",
  "blog_post",
  "login",
  "logout",
  "phone_mandate",
  "profile",
  "profile_regulatory",
  "profile_account",
  "profile_account_phone",
  "profile_preferences",
  "profile_preferences_kai",
  "profile_preferences_gemini",
  "profile_preferences_device",
  "profile_preferences_voice",
  "profile_preferences_voice_changelog",
  "profile_preferences_voice_examples",
  "profile_security",
  "profile_security_vault",
  "profile_security_session",
  "profile_security_devices",
  "profile_security_device_authorize",
  "profile_my_data",
  "profile_my_data_domain",
  "profile_access",
  "profile_access_connection",
  "profile_connected_systems",
  "profile_integrations",
  "profile_google_oauth_return",
  "one_calendar",
  "profile_gmail",
  "profile_gmail_connection",
  "profile_gmail_actions",
  "profile_referrals",
  "referral_landing",
  "profile_support",
  "profile_support_routing",
  "profile_support_compose",
  "gmail",
  "email_agent",
  "pkm",
  "connected_systems",
  "profile_pkm",
  "profile_pkm_agent_lab",
  "profile_receipts",
  "profile_gmail_oauth_return",
  "oauth_authorize",
  "consents",
  "feed",
  "agent",
  "connect",
  "connect_settings",
  "marketplace",
  "marketplace_connections",
  "marketplace_connection_portfolio",
  "marketplace_ria_profile",
  "one_kyc",
  "one_marketplace",
  "one_location",
  "one_location_map",
  "one_location_check_in",
  "one_location_public_request",
  "one_location_circle_invite",
  "one_location_circle_join",
  "one_wallet_card",
  "wallet_card_public",
  "portfolio_shared",
  "ria_home",
  "ria_onboarding",
  "ria_claim",
  "ria_clients",
  "ria_requests",
  "ria_picks",
  "ria_settings",
  "ria_workspace",
  "kai_home",
  "kai_market_news",
  "one_setup",
  "kai_import",
  "kai_plaid_oauth_return",
  "kai_alpaca_oauth_return",
  "kai_dashboard",
  "kai_portfolio_holdings",
  "kai_portfolio_allocation",
  "kai_portfolio_performance",
  "kai_portfolio_sources",
  "kai_analysis",
  "kai_optimize",
  "kai_dashboard_legacy_redirect",
  "unknown",
] as const;

export type RouteId = (typeof ROUTE_ID_VALUES)[number];

/**
 * Brings a pathname to the shape the match table below expects.
 *
 * The native build sets `trailingSlash: true` (`next.config.ts`, gated on
 * `isCapacitorBuild`), so on iOS and Android every route arrives as
 * `/one/location/` while this table compares with `===` against `/one/location`.
 * The result was that essentially every native screen resolved to "unknown":
 * over 30 days, 117 iOS users and 7,504 views landed in that bucket, and the
 * only native routes that did resolve were the handful matched by a
 * `startsWith(".../")` prefix, plus the root.
 *
 * That is also a privacy matter, not only a reporting one. As the comments
 * further down note, "unknown" is not inert — callers that fall through to it
 * log the raw pathname, and on the share-link routes the pathname *is* the
 * token. Fewer fall-throughs means fewer raw paths written anywhere.
 *
 * Delegates the trailing-slash and index-document handling to
 * `normalizeStaticExportPathname`, which route admission and the analytics
 * exemption check already use. A second private copy would be free to drift
 * from it, and a disagreement between this and `isAnalyticsExemptRoute` is
 * precisely the case where an unexempted event writes a share token into the
 * dataLayer. Query and hash are stripped here on top, so a caller passing a
 * full href degrades to the right route id rather than to "unknown".
 */
function normalizeRoutePathname(pathname: string): string {
  if (!pathname) return "/";
  const withoutQuery = pathname.split("?")[0]!.split("#")[0]!;
  return normalizeStaticExportPathname(withoutQuery);
}

export function resolveRouteId(rawPathname: string): RouteId {
  const pathname = normalizeRoutePathname(rawPathname);
  if (
    pathname === ROUTES.HOME ||
    pathname === ROUTES.ONE_HOME ||
    pathname === ROUTES.WELCOME
  ) {
    return "one_dashboard";
  }
  if (pathname === ROUTES.GETTING_STARTED) return "getting_started";
  if (
    pathname === ROUTES.ONE_SETUP ||
    pathname.startsWith(`${ROUTES.ONE_SETUP}/`)
  ) {
    return "one_setup";
  }
  if (pathname === ROUTES.DEVELOPERS) return "developers";
  if (pathname === ROUTES.RESEARCH) return "research";
  if (pathname === ROUTES.RESEARCH_PROTOCOL) return "research_protocol";
  if (pathname === HUSHH_TECH_LAUNCH_PATH) return "hushh_tech_launch";
  if (pathname === ROUTES.BLOG) return "blog";
  if (pathname.startsWith(`${ROUTES.BLOG}/`)) return "blog_post";
  if (pathname === ROUTES.LOGIN) return "login";
  if (pathname === ROUTES.LOGOUT) return "logout";
  if (pathname === ROUTES.PHONE_MANDATE) return "phone_mandate";
  if (pathname === ROUTES.PROFILE) return "profile";
  if (pathname === ROUTES.PROFILE_REGULATORY) return "profile_regulatory";
  if (pathname === ROUTES.PROFILE_ACCOUNT) return "profile_account";
  if (pathname === ROUTES.PROFILE_ACCOUNT_PHONE) return "profile_account_phone";
  if (pathname === ROUTES.PROFILE_PREFERENCES) return "profile_preferences";
  if (pathname === ROUTES.PROFILE_PREFERENCES_KAI)
    return "profile_preferences_kai";
  if (pathname === ROUTES.PROFILE_PREFERENCES_GEMINI)
    return "profile_preferences_gemini";
  if (pathname === ROUTES.PROFILE_PREFERENCES_DEVICE)
    return "profile_preferences_device";
  if (pathname === ROUTES.PROFILE_PREFERENCES_VOICE)
    return "profile_preferences_voice";
  if (pathname === ROUTES.PROFILE_PREFERENCES_VOICE_CHANGELOG)
    return "profile_preferences_voice_changelog";
  if (pathname === ROUTES.PROFILE_PREFERENCES_VOICE_EXAMPLES)
    return "profile_preferences_voice_examples";
  if (pathname === ROUTES.PROFILE_SECURITY) return "profile_security";
  if (pathname === ROUTES.PROFILE_SECURITY_VAULT)
    return "profile_security_vault";
  if (pathname === ROUTES.PROFILE_SECURITY_SESSION)
    return "profile_security_session";
  if (pathname === ROUTES.PROFILE_SECURITY_DEVICES)
    return "profile_security_devices";
  if (pathname === ROUTES.PROFILE_SECURITY_DEVICE_AUTHORIZE)
    return "profile_security_device_authorize";
  if (pathname === ROUTES.PROFILE_MY_DATA) return "profile_my_data";
  if (pathname === ROUTES.PROFILE_MY_DATA_DOMAIN)
    return "profile_my_data_domain";
  if (pathname === ROUTES.PROFILE_ACCESS) return "profile_access";
  if (pathname === ROUTES.PROFILE_ACCESS_CONNECTION)
    return "profile_access_connection";
  if (pathname === ROUTES.PROFILE_CONNECTED_SYSTEMS)
    return "profile_connected_systems";
  if (pathname === ROUTES.PROFILE_INTEGRATIONS) return "profile_integrations";
  // Both the /one-prefixed route and the bare legacy path land here; an OAuth
  // return that falls through to "unknown" logs a raw pathname carrying
  // provider state, which is the same reasoning as the Gmail return below.
  if (
    pathname === ROUTES.PROFILE_GOOGLE_OAUTH_RETURN ||
    pathname === "/profile/google/oauth/return"
  ) {
    return "profile_google_oauth_return";
  }
  if (pathname === ROUTES.CALENDAR) return "one_calendar";
  if (pathname === ROUTES.PROFILE_GMAIL) return "profile_gmail";
  if (pathname === ROUTES.PROFILE_GMAIL_CONNECTION)
    return "profile_gmail_connection";
  if (pathname === ROUTES.PROFILE_GMAIL_ACTIONS) return "profile_gmail_actions";
  if (/^\/r\/[^/]+$/.test(pathname)) return "referral_landing";
  if (pathname === ROUTES.PROFILE_REFERRALS) return "profile_referrals";
  if (pathname === ROUTES.PROFILE_SUPPORT) return "profile_support";
  if (pathname === ROUTES.PROFILE_SUPPORT_ROUTING)
    return "profile_support_routing";
  if (pathname === ROUTES.PROFILE_SUPPORT_COMPOSE)
    return "profile_support_compose";
  if (pathname === ROUTES.GMAIL || pathname === ROUTES.LEGACY_GMAIL)
    return "gmail";
  if (pathname === ROUTES.EMAIL_AGENT) return "email_agent";
  if (pathname === ROUTES.PKM || pathname === ROUTES.LEGACY_PKM) return "pkm";
  if (pathname === ROUTES.ONE_MARKETPLACE) return "one_marketplace";
  if (
    pathname === ROUTES.CONNECTED_SYSTEMS ||
    pathname === ROUTES.LEGACY_CONNECTED_SYSTEMS
  ) {
    return "connected_systems";
  }
  if (
    pathname.startsWith(`${ROUTES.CONNECTED_SYSTEMS}/`) ||
    pathname.startsWith(`${ROUTES.LEGACY_CONNECTED_SYSTEMS}/`)
  ) {
    return "connected_systems";
  }
  if (pathname === ROUTES.PROFILE_PKM) return "profile_pkm";
  if (pathname === ROUTES.PROFILE_PKM_AGENT_LAB) return "profile_pkm_agent_lab";
  if (pathname === ROUTES.PROFILE_RECEIPTS) return "profile_receipts";
  if (pathname === ROUTES.PROFILE_GMAIL_OAUTH_RETURN) {
    return "profile_gmail_oauth_return";
  }
  if (pathname === ROUTES.OAUTH_AUTHORIZE) return "oauth_authorize";
  if (pathname === ROUTES.CONSENTS || pathname === ROUTES.LEGACY_CONSENTS) {
    return "consents";
  }
  if (pathname === ROUTES.ONE_FEED) return "feed";
  if (pathname === ROUTES.AGENT) return "agent";
  if (pathname === ROUTES.CONNECT) return "connect";
  if (pathname === ROUTES.CONNECT_SETTINGS) return "connect_settings";
  if (pathname === ROUTES.MARKETPLACE) return "marketplace";
  if (pathname === ROUTES.MARKETPLACE_CONNECTIONS)
    return "marketplace_connections";
  if (pathname === `${ROUTES.MARKETPLACE_CONNECTIONS}/portfolio`) {
    return "marketplace_connection_portfolio";
  }
  if (
    pathname === ROUTES.MARKETPLACE_RIA_PROFILE ||
    pathname.startsWith(`${ROUTES.MARKETPLACE_RIA_PROFILE}/`)
  ) {
    return "marketplace_ria_profile";
  }
  if (pathname === ROUTES.ONE_KYC) return "one_kyc";
  if (pathname === ROUTES.ONE_LOCATION_MAP) return "one_location_map";
  // Its own id rather than the map's: these are separate screens now, and
  // folding them together would hide the split from every page-view metric.
  if (pathname === ROUTES.ONE_LOCATION_CHECK_IN) return "one_location_check_in";
  if (pathname === ROUTES.ONE_LOCATION) return "one_location";
  // Both paths and both forms.
  //
  // The page moved from `/one/location/request/<token>` to
  // `/one/location/view/<token>`; the old path still resolves because links
  // minted under it are already in messages that were sent. They report the
  // SAME id on purpose — it is one screen, and splitting it would break every
  // dashboard reading this route at the moment of the rename, for a name only
  // this file ever sees.
  //
  // Both forms of each: the bare route and a token beneath it. Normalization
  // strips the trailing slash, so a `startsWith(".../")` check alone would send
  // "/one/location/view/" to "unknown" — and falling through logs the raw
  // pathname on the one route family whose pathname carries a share token.
  if (
    pathname === "/one/location/view" ||
    pathname.startsWith("/one/location/view/") ||
    pathname === "/one/location/request" ||
    pathname.startsWith("/one/location/request/")
  )
    return "one_location_public_request";
  // Both forms: the bare route and a token beneath it. Normalization strips the
  // trailing slash, so a `startsWith("/one/location/invite/")` check alone would send
  // "/one/location/invite/" to "unknown" — and falling through logs the raw pathname on the
  // one route family whose pathname carries a share token.
  if (pathname === "/one/location/invite" || pathname.startsWith("/one/location/invite/"))
    return "one_location_circle_invite";
  // Recipient landing for a shared Circle join link. It only forwards into
  // /one/location with the code pre-filled, but it still needs an id: falling
  // through to "unknown" logs the raw pathname, and this route's query carries
  // a join code. Same reasoning as the public request and invite links above.
  if (pathname === "/circle/join") return "one_location_circle_join";
  if (pathname === ROUTES.ONE_WALLET_CARD) return "one_wallet_card";
  // The scanned page emits no analytics of its own (isAnalyticsExemptRoute),
  // so this ID is never attached to a page view. It exists because "unknown"
  // is not inert: callers that fall through to it log the raw pathname, and on
  // this route the pathname *is* the share token. Same shape as the public
  // location request link above.
  if (pathname === "/c" || pathname.startsWith("/c/"))
    return "wallet_card_public";
  if (pathname === "/portfolio/shared") return "portfolio_shared";
  if (pathname === ROUTES.RIA_HOME) return "ria_home";
  if (pathname === ROUTES.RIA_ONBOARDING) return "ria_onboarding";
  if (pathname === ROUTES.RIA_CLAIM) return "ria_claim";
  if (pathname === ROUTES.RIA_CLIENTS) return "ria_clients";
  if (pathname === ROUTES.RIA_REQUESTS) return "ria_requests";
  if (pathname === ROUTES.RIA_PICKS) return "ria_picks";
  if (pathname === ROUTES.RIA_PROFILE) return "profile_regulatory";
  if (pathname === ROUTES.RIA_SETTINGS) return "ria_settings";
  if (
    pathname === ROUTES.RIA_WORKSPACE ||
    pathname.startsWith(`${ROUTES.RIA_HOME}/workspace/`) ||
    pathname.startsWith(`${ROUTES.RIA_CLIENTS}/`)
  ) {
    return "ria_workspace";
  }
  // Finance is the query-backed One workspace. Retain the legacy `/kai` route
  // only long enough for redirect telemetry to preserve its route ID.
  if (
    pathname === KAI_MARKET_PATH ||
    pathname === ROUTES.LEGACY_ONE_KAI_MARKET ||
    pathname === ROUTES.LEGACY_KAI_HOME
  ) {
    return "kai_home";
  }
  if (pathname === ROUTES.KAI_NEWS) return "kai_market_news";
  if (
    pathname === ROUTES.ONE_SETUP ||
    pathname.startsWith(`${ROUTES.ONE_SETUP}/`) ||
    pathname === ROUTES.LEGACY_ONE_KAI_ONBOARDING ||
    pathname === ROUTES.LEGACY_KAI_ONBOARDING
  ) {
    return "one_setup";
  }
  if (pathname === ROUTES.KAI_IMPORT || pathname === ROUTES.LEGACY_KAI_IMPORT) {
    return "kai_import";
  }
  if (
    pathname === ROUTES.KAI_PLAID_OAUTH_RETURN ||
    pathname === ROUTES.LEGACY_KAI_PLAID_OAUTH_RETURN
  ) {
    return "kai_plaid_oauth_return";
  }
  if (
    pathname === ROUTES.KAI_ALPACA_OAUTH_RETURN ||
    pathname === ROUTES.LEGACY_KAI_ALPACA_OAUTH_RETURN
  ) {
    return "kai_alpaca_oauth_return";
  }
  if (
    pathname === ROUTES.KAI_DASHBOARD ||
    pathname === ROUTES.LEGACY_KAI_PORTFOLIO ||
    pathname === "/one/kai/portfolio"
  ) {
    return "kai_dashboard";
  }
  if (pathname === ROUTES.KAI_PORTFOLIO_HOLDINGS) {
    return "kai_portfolio_holdings";
  }
  if (pathname === ROUTES.KAI_PORTFOLIO_ALLOCATION) {
    return "kai_portfolio_allocation";
  }
  if (pathname === ROUTES.KAI_PORTFOLIO_PERFORMANCE) {
    return "kai_portfolio_performance";
  }
  if (pathname === ROUTES.KAI_PORTFOLIO_SOURCES) {
    return "kai_portfolio_sources";
  }
  if (
    pathname === "/kai/investments" ||
    pathname === "/one/kai/investments" ||
    pathname === "/kai/funding-trade" ||
    pathname === "/one/kai/funding-trade"
  ) {
    return "kai_dashboard_legacy_redirect";
  }
  if (
    pathname === ROUTES.KAI_ANALYSIS ||
    pathname === ROUTES.LEGACY_KAI_ANALYSIS ||
    pathname === "/one/kai/analysis"
  ) {
    return "kai_analysis";
  }
  if (
    pathname === ROUTES.KAI_OPTIMIZE_COMPAT ||
    pathname === ROUTES.LEGACY_KAI_OPTIMIZE_COMPAT
  ) {
    return "kai_dashboard_legacy_redirect";
  }
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
    regex: /^\/api\/one\/location\/recipient-keys(?:\?.*)?$/i,
    template: "/api/one/location/recipient-keys",
  },
  {
    regex: /^\/api\/one\/location\/state(?:\?.*)?$/i,
    template: "/api/one/location/state",
  },
  {
    regex: /^\/api\/one\/location\/grants(?:\?.*)?$/i,
    template: "/api/one/location/grants",
  },
  {
    regex: /^\/api\/one\/location\/grants\/[^/?]+\/envelopes(?:\?.*)?$/i,
    template: "/api/one/location/grants/{grant_id}/envelopes",
  },
  {
    regex: /^\/api\/one\/location\/grants\/[^/?]+\/envelope(?:\?.*)?$/i,
    template: "/api/one/location/grants/{grant_id}/envelope",
  },
  {
    regex: /^\/api\/one\/location\/grants\/[^/?]+(?:\?.*)?$/i,
    template: "/api/one/location/grants/{grant_id}",
  },
  {
    regex: /^\/api\/one\/location\/requests(?:\?.*)?$/i,
    template: "/api/one/location/requests",
  },
  {
    regex: /^\/api\/one\/location\/requests\/[^/?]+\/approve(?:\?.*)?$/i,
    template: "/api/one/location/requests/{request_id}/approve",
  },
  {
    regex: /^\/api\/one\/location\/requests\/[^/?]+\/deny(?:\?.*)?$/i,
    template: "/api/one/location/requests/{request_id}/deny",
  },
  {
    regex: /^\/api\/one\/location\/grants\/[^/?]+\/refer(?:\?.*)?$/i,
    template: "/api/one/location/grants/{grant_id}/refer",
  },
  {
    regex: /^\/api\/one\/location\/public-invites(?:\?.*)?$/i,
    template: "/api/one/location/public-invites",
  },
  {
    regex: /^\/api\/one\/location\/public-invites\/[^/?]+\/submit(?:\?.*)?$/i,
    template: "/api/one/location/public-invites/{public_token}/submit",
  },
  {
    regex: /^\/api\/one\/location\/public-invites\/[^/?]+(?:\?.*)?$/i,
    template: "/api/one/location/public-invites/{public_invite_id}",
  },
  {
    regex: /^\/api\/kai\/agent\/chat\/stream(?:\?.*)?$/i,
    template: "/api/kai/agent/chat/stream",
  },
  {
    regex: /^\/api\/kai\/agent\/chat\/conversations\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/agent/chat/conversations/{user_id}",
  },
  {
    regex: /^\/api\/kai\/agent\/chat\/history\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/agent/chat/history/{conversation_id}",
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
    regex: /^\/api\/kai\/market\/news\/baseline\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/market/news/baseline/{user_id}",
  },
  {
    regex: /^\/api\/kai\/market\/news\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/market/news/{user_id}",
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
    regex:
      /^\/api\/kai\/plaid\/funding\/admin\/transfers\/[^/?]+\/refresh(?:\?.*)?$/i,
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
    regex: /^\/api\/one\/kyc\/workflows(?:\?.*)?$/i,
    template: "/api/one/kyc/workflows",
  },
  {
    regex: /^\/api\/one\/kyc\/workflows\/[^/?]+(?:\?.*)?$/i,
    template: "/api/one/kyc/workflows/{workflow_id}",
  },
  {
    regex: /^\/api\/one\/kyc\/workflows\/[^/?]+\/refresh(?:\?.*)?$/i,
    template: "/api/one/kyc/workflows/{workflow_id}/refresh",
  },
  {
    regex: /^\/api\/one\/kyc\/workflows\/[^/?]+\/approve-draft(?:\?.*)?$/i,
    template: "/api/one/kyc/workflows/{workflow_id}/approve-draft",
  },
  {
    regex: /^\/api\/one\/kyc\/workflows\/[^/?]+\/reject-draft(?:\?.*)?$/i,
    template: "/api/one/kyc/workflows/{workflow_id}/reject-draft",
  },
  {
    regex: /^\/api\/one\/kyc\/workflows\/[^/?]+\/redraft(?:\?.*)?$/i,
    template: "/api/one/kyc/workflows/{workflow_id}/redraft",
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
    regex: /^\/api\/account\/export(?:\?.*)?$/i,
    template: "/api/account/export",
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
    regex: /^\/api\/connected-systems(?:\?.*)?$/i,
    template: "/api/connected-systems",
  },
  {
    regex: /^\/api\/connected-systems\/[^/?]+\/schema(?:\?.*)?$/i,
    template: "/api/connected-systems/{system_id}/schema",
  },
  {
    regex: /^\/api\/connected-systems\/[^/?]+\/records\/read(?:\?.*)?$/i,
    template: "/api/connected-systems/{system_id}/records/read",
  },
  {
    regex:
      /^\/api\/connected-systems\/[^/?]+\/records\/create-intents(?:\?.*)?$/i,
    template: "/api/connected-systems/{system_id}/records/create-intents",
  },
  {
    regex:
      /^\/api\/connected-systems\/[^/?]+\/records\/update-intents(?:\?.*)?$/i,
    template: "/api/connected-systems/{system_id}/records/update-intents",
  },
  {
    regex:
      /^\/api\/connected-systems\/[^/?]+\/intents\/[^/?]+\/approve(?:\?.*)?$/i,
    template: "/api/connected-systems/{system_id}/intents/{intent_id}/approve",
  },
  {
    regex:
      /^\/api\/connected-systems\/[^/?]+\/intents\/[^/?]+\/reject(?:\?.*)?$/i,
    template: "/api/connected-systems/{system_id}/intents/{intent_id}/reject",
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
    regex: /^\/api\/iam\/contact-discoverability(?:\?.*)?$/i,
    template: "/api/iam/contact-discoverability",
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
          segment,
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

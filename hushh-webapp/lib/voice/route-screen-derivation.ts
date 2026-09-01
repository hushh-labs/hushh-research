import { KAI_MARKET_PATH, ROUTES } from "@/lib/navigation/routes";
import { resolveProfileRouteState } from "@/lib/navigation/profile-routes";

export type VoiceRouteScreenInfo = {
  screen: string;
  subview?: string | null;
};

function toSearchParams(
  searchParams?: URLSearchParams | string,
): URLSearchParams {
  if (searchParams instanceof URLSearchParams) {
    return new URLSearchParams(searchParams.toString());
  }
  if (typeof searchParams === "string") {
    const normalized = searchParams.startsWith("?")
      ? searchParams.slice(1)
      : searchParams;
    return new URLSearchParams(normalized);
  }
  return new URLSearchParams();
}

export function deriveVoiceRouteScreen(
  pathname: string,
  searchParams?: URLSearchParams | string,
): VoiceRouteScreenInfo {
  const [normalizedPath, rawQuery = ""] = String(pathname || "").split("?");
  const query =
    searchParams === undefined
      ? new URLSearchParams(rawQuery)
      : toSearchParams(searchParams);
  if (!normalizedPath) {
    return { screen: "unknown", subview: null };
  }
  if (normalizedPath === ROUTES.HOME) {
    return { screen: "one_intro", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_HOME) {
    return { screen: "one_agents", subview: null };
  }
  if (normalizedPath === "/people/[personRef]") {
    return { screen: "one_person_profile", subview: null };
  }
  if (normalizedPath === ROUTES.GETTING_STARTED) {
    return { screen: "getting_started", subview: null };
  }
  if (normalizedPath === ROUTES.LOGIN) {
    return { screen: "login", subview: null };
  }
  if (normalizedPath === ROUTES.LOGOUT) {
    return { screen: "logout", subview: null };
  }
  if (normalizedPath === "/register-phone") {
    return { screen: "register_phone", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_SETUP) {
    return { screen: "one_setup_hub", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_SETUP_CONNECTIONS) {
    return { screen: "one_setup_connections", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_SETUP_GMAIL) {
    return { screen: "one_setup_gmail", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_SETUP_LOCATION) {
    return { screen: "one_setup_location", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_SETUP_EMAIL) {
    return { screen: "one_setup_email", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_SETUP_FINANCE) {
    return { screen: "one_setup_finance", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_SETUP_FINANCE_IMPORT) {
    return { screen: "one_setup_finance_import", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_SETUP_RIA) {
    return { screen: "one_setup_ria", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_SETUP_CONNECTED_SYSTEMS) {
    return { screen: "one_setup_connected_systems", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_SETUP_CALENDAR) {
    return { screen: "one_setup_calendar", subview: null };
  }
  // The standalone Calendar feature page, plus the OAuth return and
  // integrations routes that only exist to land back on it -- all four are
  // one screen in the orchestration index.
  if (
    normalizedPath === ROUTES.CALENDAR ||
    normalizedPath === ROUTES.PROFILE_INTEGRATIONS ||
    normalizedPath === ROUTES.PROFILE_GOOGLE_OAUTH_RETURN ||
    normalizedPath === "/profile/google/oauth/return"
  ) {
    return { screen: "calendar", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_SETUP_KAI) {
    return { screen: "one_setup_finance", subview: "legacy" };
  }
  if (
    normalizedPath === ROUTES.KAI_PLAID_OAUTH_RETURN ||
    normalizedPath === ROUTES.LEGACY_KAI_PLAID_OAUTH_RETURN
  ) {
    return { screen: "kai_plaid_oauth_return", subview: null };
  }
  if (
    normalizedPath === ROUTES.KAI_ALPACA_OAUTH_RETURN ||
    normalizedPath === ROUTES.LEGACY_KAI_ALPACA_OAUTH_RETURN
  ) {
    return { screen: "kai_alpaca_oauth_return", subview: null };
  }
  if (normalizedPath === ROUTES.KAI_NEWS) {
    return { screen: "kai_market_news", subview: null };
  }
  if (normalizedPath === KAI_MARKET_PATH) {
    const tab = query.get("tab") || "market";
    if (tab === "analysis") {
      return {
        screen: "kai_analysis",
        subview: query.get("focus") === "active" ? "active" : "analysis",
      };
    }
    if (tab === "portfolio") {
      return { screen: "kai_portfolio_dashboard", subview: "portfolio" };
    }
    return { screen: "kai_market", subview: "market" };
  }
  // These paths exist only long enough to redirect bookmarked Finance links.
  // Keep their semantic screen until the client redirect completes.
  if (normalizedPath === "/one/kai/portfolio") {
    return { screen: "kai_portfolio_dashboard", subview: null };
  }
  if (normalizedPath === ROUTES.KAI_PORTFOLIO_HOLDINGS) {
    return { screen: "kai_portfolio_holdings", subview: null };
  }
  if (normalizedPath === ROUTES.KAI_PORTFOLIO_ALLOCATION) {
    return { screen: "kai_portfolio_allocation", subview: null };
  }
  if (normalizedPath === ROUTES.KAI_PORTFOLIO_PERFORMANCE) {
    return { screen: "kai_portfolio_performance", subview: null };
  }
  if (normalizedPath === ROUTES.KAI_PORTFOLIO_SOURCES) {
    return { screen: "kai_portfolio_sources", subview: null };
  }
  if (
    normalizedPath === "/kai/investments" ||
    normalizedPath === "/one/kai/investments" ||
    normalizedPath === "/kai/funding-trade" ||
    normalizedPath === "/one/kai/funding-trade"
  ) {
    return { screen: "kai_portfolio_dashboard", subview: "portfolio" };
  }
  if (normalizedPath === "/one/kai/analysis") {
    return {
      screen: "kai_analysis",
      subview: query.get("focus") === "active" ? "active" : null,
    };
  }
  if (
    normalizedPath === ROUTES.LEGACY_KAI_HOME ||
    normalizedPath.startsWith("/kai/home")
  ) {
    return { screen: "kai_market", subview: query.get("tab") || null };
  }
  if (
    normalizedPath.startsWith("/kai/dashboard") ||
    normalizedPath.startsWith("/one/kai/dashboard") ||
    normalizedPath.startsWith(ROUTES.LEGACY_KAI_PORTFOLIO)
  ) {
    const segments = normalizedPath.split("/").filter(Boolean);
    const subview =
      normalizedPath === ROUTES.LEGACY_KAI_PORTFOLIO
        ? null
        : query.get("tab") || segments.at(-1) || null;
    return {
      screen: "kai_portfolio_dashboard",
      subview,
    };
  }
  if (normalizedPath.startsWith(ROUTES.LEGACY_KAI_ANALYSIS)) {
    return {
      screen: "kai_analysis",
      subview:
        query.get("tab") || (query.get("focus") === "active" ? "active" : null),
    };
  }
  if (
    normalizedPath.startsWith(ROUTES.KAI_IMPORT) ||
    normalizedPath.startsWith(ROUTES.LEGACY_KAI_IMPORT)
  ) {
    return { screen: "import", subview: null };
  }
  if (
    normalizedPath.startsWith(ROUTES.KAI_OPTIMIZE_COMPAT) ||
    normalizedPath.startsWith(ROUTES.LEGACY_KAI_OPTIMIZE_COMPAT)
  ) {
    return { screen: "kai_portfolio_dashboard", subview: "overview" };
  }
  if (normalizedPath === ROUTES.RIA_HOME) {
    return { screen: "ria_home", subview: query.get("tab") || null };
  }
  if (normalizedPath === ROUTES.RIA_ONBOARDING) {
    return { screen: "ria_onboarding", subview: query.get("step") || null };
  }
  if (normalizedPath === ROUTES.RIA_CLAIM) {
    return { screen: "ria_claim", subview: null };
  }
  if (normalizedPath === ROUTES.RIA_PROFILE) {
    return { screen: "profile_regulatory", subview: query.get("tab") || null };
  }
  if (normalizedPath === ROUTES.RIA_CLIENTS) {
    return { screen: "ria_clients", subview: query.get("tab") || null };
  }
  if (normalizedPath.startsWith(`${ROUTES.RIA_CLIENTS}/`)) {
    if (normalizedPath.includes("/accounts/")) {
      return {
        screen: "ria_client_account_detail",
        subview: query.get("tab") || null,
      };
    }
    if (normalizedPath.includes("/requests/")) {
      return {
        screen: "ria_client_request_detail",
        subview: query.get("tab") || null,
      };
    }
    return {
      screen: "ria_client_workspace",
      subview: query.get("tab") || "overview",
    };
  }
  if (normalizedPath.startsWith(ROUTES.RIA_WORKSPACE)) {
    return { screen: "ria_workspace", subview: query.get("tab") || null };
  }
  if (normalizedPath.startsWith(ROUTES.RIA_REQUESTS)) {
    return { screen: "ria_requests", subview: query.get("tab") || null };
  }
  if (normalizedPath.startsWith(ROUTES.RIA_PICKS)) {
    return { screen: "ria_picks", subview: query.get("tab") || null };
  }
  if (normalizedPath.startsWith(ROUTES.RIA_SETTINGS)) {
    return { screen: "ria_settings", subview: query.get("tab") || null };
  }
  if (
    normalizedPath.startsWith(ROUTES.CONSENTS) ||
    normalizedPath.startsWith(ROUTES.LEGACY_CONSENTS)
  ) {
    return { screen: "consents", subview: query.get("tab") || null };
  }
  if (normalizedPath === ROUTES.ONE_KYC) {
    return { screen: "one_kyc", subview: query.get("panel") || null };
  }
  if (normalizedPath === ROUTES.ONE_FEED) {
    return { screen: "one_feed", subview: null };
  }
  if (normalizedPath === ROUTES.CONNECT) {
    // Connect had no branch here at all, so it derived the generic "app"
    // screen: it could neither publish an inventory nor be named as a
    // destination, which is why nothing in the app could send anyone to it.
    // Its tabs are local component state rather than query params, so there is
    // no subview to report.
    return { screen: "connect", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_LOCATION_MAP) {
    return { screen: "one_location_map", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_LOCATION_CHECK_IN) {
    return { screen: "one_location_check_in", subview: null };
  }
  if (normalizedPath === ROUTES.ONE_LOCATION) {
    // Location's hub owns two query params, and neither is `tab`: `view`
    // selects the Now/People/Links tab, and `action` opens a focused flow on
    // top of it. Reading `tab` here always returned null, so One believed the
    // person was on a bare Location page however deep they actually were. The
    // open flow is the more specific answer, so it wins over the tab.
    return {
      screen: "one_location",
      subview: query.get("action") || query.get("view") || null,
    };
  }
  if (
    normalizedPath === ROUTES.GMAIL ||
    normalizedPath === ROUTES.LEGACY_GMAIL
  ) {
    return { screen: "gmail", subview: null };
  }
  if (normalizedPath === ROUTES.PKM || normalizedPath === ROUTES.LEGACY_PKM) {
    return { screen: "pkm", subview: query.get("tab") || null };
  }
  if (
    normalizedPath === ROUTES.CONNECTED_SYSTEMS ||
    normalizedPath === ROUTES.LEGACY_CONNECTED_SYSTEMS
  ) {
    return { screen: "connected_systems", subview: query.get("tab") || null };
  }
  if (normalizedPath.startsWith(ROUTES.MARKETPLACE_RIA_PROFILE)) {
    return {
      screen: "marketplace_ria_profile",
      subview: query.get("riaId") ? "profile" : null,
    };
  }
  if (normalizedPath.startsWith(ROUTES.ONE_MARKETPLACE)) {
    return { screen: "one_marketplace", subview: query.get("tab") || null };
  }
  if (normalizedPath.startsWith(ROUTES.MARKETPLACE)) {
    return { screen: "marketplace", subview: query.get("tab") || null };
  }
  if (normalizedPath === ROUTES.PROFILE_PKM) {
    return {
      screen: "pkm",
      subview: query.get("tab") || "legacy",
    };
  }
  if (normalizedPath === ROUTES.PROFILE_PKM_AGENT_LAB) {
    return {
      screen: "profile_pkm_agent_lab",
      subview: query.get("tab"),
    };
  }
  if (normalizedPath === ROUTES.PROFILE_RECEIPTS) {
    return { screen: "gmail", subview: "legacy" };
  }
  if (normalizedPath === ROUTES.PROFILE_SECURITY_DEVICES) {
    return { screen: "profile_security_devices", subview: null };
  }
  if (normalizedPath === ROUTES.PROFILE_SECURITY_DEVICE_AUTHORIZE) {
    return { screen: "app", subview: "trusted-device-authorization" };
  }
  // Legacy direct links settle immediately on the canonical RIA profile.
  if (normalizedPath === ROUTES.PROFILE_REGULATORY) {
    return { screen: "profile_regulatory", subview: null };
  }
  if (normalizedPath === ROUTES.PROFILE) {
    const { panel } = resolveProfileRouteState(normalizedPath, query);
    const tab = query.get("tab");
    if (panel === "gmail") {
      return { screen: "profile_gmail_panel", subview: tab || null };
    }
    if (panel === "connected-systems") {
      return { screen: "connected_systems", subview: tab || "legacy" };
    }
    if (panel === "referrals") {
      return { screen: "profile_referrals_panel", subview: tab || null };
    }
    if (panel === "support") {
      return { screen: "profile_support_panel", subview: tab || null };
    }
    if (panel === "security") {
      return { screen: "profile_security_panel", subview: tab || null };
    }
    if (tab === "preferences") {
      return { screen: "profile_preferences", subview: null };
    }
    if (tab === "privacy") {
      // Legacy ?tab=privacy now resolves to the unified Memory panel.
      return {
        screen: "profile_privacy",
        subview: panel === "my-data" ? null : panel || null,
      };
    }
    return { screen: "profile_account", subview: panel || null };
  }
  if (normalizedPath.startsWith(`${ROUTES.PROFILE}/`)) {
    const { panel, detail } = resolveProfileRouteState(normalizedPath, query);
    if (panel === "gmail") {
      return {
        screen: "profile_gmail_panel",
        subview: detail?.replace(/^gmail-/, "") || null,
      };
    }
    if (panel === "connected-systems") {
      return { screen: "connected_systems", subview: "legacy" };
    }
    if (panel === "referrals") {
      return { screen: "profile_referrals_panel", subview: null };
    }
    if (panel === "support") {
      return {
        screen: "profile_support_panel",
        subview: detail?.replace(/^support-/, "") || null,
      };
    }
    if (panel === "security") {
      return { screen: "profile_security_panel", subview: detail || null };
    }
    if (panel === "preferences") {
      return { screen: "profile_preferences", subview: detail || null };
    }
    if (panel === "my-data") {
      // Sharing (legacy /one/profile/access) is a sub-view of Memory now; keep
      // reporting it under the privacy screen for analytics continuity.
      if (detail === "sharing" || detail?.startsWith("connection:")) {
        return { screen: "profile_privacy", subview: detail };
      }
      return { screen: "profile_my_data", subview: detail || null };
    }
    return { screen: "profile_account", subview: detail || panel || null };
  }
  if (normalizedPath.startsWith(KAI_MARKET_PATH)) {
    return { screen: "kai_market", subview: query.get("tab") || "market" };
  }
  if (normalizedPath.startsWith(ROUTES.LEGACY_KAI_HOME)) {
    const subview = normalizedPath
      .slice(ROUTES.LEGACY_KAI_HOME.length)
      .split("/")
      .filter(Boolean)[0];
    return { screen: "kai", subview: subview || null };
  }
  return { screen: "app", subview: null };
}

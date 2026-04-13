import { ROUTES } from "@/lib/navigation/routes";

export type VoiceRouteScreenInfo = {
  screen: string;
  subview?: string | null;
};

function toSearchParams(searchParams?: URLSearchParams | string): URLSearchParams {
  if (searchParams instanceof URLSearchParams) {
    return new URLSearchParams(searchParams.toString());
  }
  if (typeof searchParams === "string") {
    const normalized = searchParams.startsWith("?") ? searchParams.slice(1) : searchParams;
    return new URLSearchParams(normalized);
  }
  return new URLSearchParams();
}

export function deriveVoiceRouteScreen(
  pathname: string,
  searchParams?: URLSearchParams | string
): VoiceRouteScreenInfo {
  const [normalizedPath, rawQuery = ""] = String(pathname || "").split("?");
  const query = searchParams === undefined ? new URLSearchParams(rawQuery) : toSearchParams(searchParams);
  if (!normalizedPath) {
    return { screen: "unknown", subview: null };
  }
  if (normalizedPath === ROUTES.KAI_HOME || normalizedPath.startsWith("/kai/home")) {
    return { screen: "kai_market", subview: query.get("tab") || null };
  }
  if (normalizedPath === ROUTES.KAI_INVESTMENTS) {
    return { screen: "kai_investments", subview: null };
  }
  if (normalizedPath === ROUTES.KAI_FUNDING_TRADE) {
    return { screen: "kai_funding_trade", subview: null };
  }
  if (normalizedPath.startsWith("/kai/dashboard") || normalizedPath.startsWith(ROUTES.KAI_PORTFOLIO)) {
    const segments = normalizedPath.split("/").filter(Boolean);
    return {
      screen: "kai_portfolio_dashboard",
      subview: query.get("tab") || segments[2] || null,
    };
  }
  if (normalizedPath.startsWith(ROUTES.KAI_ANALYSIS)) {
    return {
      screen: "kai_analysis",
      subview: query.get("tab") || (query.get("focus") === "active" ? "active" : null),
    };
  }
  if (normalizedPath.startsWith(ROUTES.KAI_IMPORT)) {
    return { screen: "import", subview: null };
  }
  if (normalizedPath.startsWith(ROUTES.KAI_OPTIMIZE)) {
    return { screen: "optimize", subview: null };
  }
  if (normalizedPath.startsWith(ROUTES.CONSENTS)) {
    return { screen: "consents", subview: query.get("tab") || null };
  }
  if (
    normalizedPath === ROUTES.PROFILE_PKM_AGENT_LAB ||
    normalizedPath === ROUTES.PROFILE_PKM
  ) {
    return {
      screen: "profile_pkm_agent_lab",
      subview: query.get("tab"),
    };
  }
  if (normalizedPath === ROUTES.PROFILE_RECEIPTS) {
    return { screen: "profile_receipts", subview: null };
  }
  if (normalizedPath === ROUTES.PROFILE) {
    const panel = query.get("panel");
    const tab = query.get("tab");
    if (panel === "gmail") {
      return { screen: "profile_gmail_panel", subview: tab || null };
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
      return { screen: "profile_privacy", subview: panel || null };
    }
    return { screen: "profile_account", subview: panel || null };
  }
  if (normalizedPath.startsWith(ROUTES.PROFILE)) {
    return { screen: "profile", subview: null };
  }
  if (normalizedPath.startsWith(ROUTES.KAI_HOME)) {
    const segments = normalizedPath.split("/").filter(Boolean);
    return { screen: "kai", subview: segments[1] || null };
  }
  return { screen: "app", subview: null };
}

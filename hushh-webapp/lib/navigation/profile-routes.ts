import type { SupportMessageKind } from "@/lib/services/support-service";

import { ROUTES } from "@/lib/navigation/routes";

export type ProfilePanel =
  | "account"
  | "hosting"
  | "software-updates"
  | "my-data"
  | "connected-systems"
  | "connectors"
  | "preferences"
  | "security"
  | "referrals"
  | "support"
  | "gmail"
  | "legal";

export type ProfileDetail =
  | `domain:${string}`
  | `connection:${string}`
  | `connector:${string}`
  | "sharing"
  | "phone"
  | "kai-preferences"
  | "gemini"
  | "device"
  | "voice"
  | "vault"
  | "session"
  | "trusted-devices"
  | "gmail-connection"
  | "gmail-actions"
  | "support-routing"
  | `support-compose:${SupportMessageKind}`
  | LegalDocumentDetail;

/** A legal document read in place inside Profile's Legal section. */
export type LegalDocumentDetail = "terms" | "privacy";

export type ProfileRouteState = {
  panel: ProfilePanel | null;
  detail: ProfileDetail | null;
};

type SearchParamReader = {
  get(name: string): string | null;
  toString?: () => string;
};

const TRANSIENT_PROFILE_QUERY_KEYS = [
  "unlock_vault",
  "return_to",
  "filter",
  "page",
  "redirect",
  // The origin the Profile hub was opened from. Preserved across panel/detail
  // drilling so the shared top-bar back control can always retrace to the
  // screen the user came from (avatar tap) instead of defaulting to One home.
  "from",
] as const;

export function normalizeProfilePanel(
  value: string | null,
): ProfilePanel | null {
  if (
    value === "hosting" ||
    value === "software-updates" ||
    value === "account" ||
    value === "my-data" ||
    value === "connected-systems" ||
    value === "connectors" ||
    value === "preferences" ||
    value === "security" ||
    value === "referrals" ||
    value === "support" ||
    value === "gmail" ||
    value === "legal"
  ) {
    return value;
  }
  return null;
}

/**
 * A connector detail names one connector by its catalog id. The id arrives
 * from the address bar, so only the catalog's own shape is accepted; anything
 * else falls back to the Connectors list rather than a half-drawn detail.
 */
const CONNECTOR_DETAIL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizeConnectorDetailId(value: string | null): string | null {
  const id = String(value || "").trim();
  return CONNECTOR_DETAIL_ID.test(id) ? id : null;
}

const BUILT_IN_CONNECTOR_TITLES: Record<string, string> = {
  gmail: "Gmail",
  google_drive: "Google Drive",
  calendar: "Calendar",
  plaid: "Plaid",
};

/**
 * The name a connector detail is shown under in the Profile header and the
 * top bar. Catalog connectors beyond the built-ins are named by the panel
 * once it has loaded them; until then the header says "Connector".
 */
export function connectorDetailTitle(detail: string | null): string | null {
  if (!detail?.startsWith("connector:")) return null;
  const id = normalizeConnectorDetailId(detail.slice("connector:".length));
  if (!id) return null;
  return BUILT_IN_CONNECTOR_TITLES[id] ?? "Connector";
}

function normalizeSupportMessageKind(
  value: string | null,
): SupportMessageKind | null {
  if (
    value === "bug_report" ||
    value === "support_request" ||
    value === "developer_reachout"
  ) {
    return value;
  }
  return null;
}

export function normalizeProfileDetail(
  panel: ProfilePanel | null,
  value: string | null,
): ProfileDetail | null {
  const detail = String(value || "").trim();
  if (!panel || !detail) return null;

  if (panel === "my-data" && detail.startsWith("domain:")) {
    return detail as ProfileDetail;
  }
  // Sharing (formerly the standalone "Access & sharing" panel) and its
  // per-connection detail are now sub-views of the unified Memory panel.
  if (panel === "my-data" && detail.startsWith("connection:")) {
    return detail as ProfileDetail;
  }
  if (panel === "my-data" && detail === "sharing") {
    return detail;
  }
  if (panel === "connectors" && detail.startsWith("connector:")) {
    const id = normalizeConnectorDetailId(detail.slice("connector:".length));
    return id ? `connector:${id}` : null;
  }
  if (panel === "account" && detail === "phone") {
    return detail;
  }
  if (
    panel === "preferences" &&
    (detail === "kai-preferences" ||
      detail === "gemini" ||
      detail === "device" ||
      detail === "voice")
  ) {
    return detail;
  }
  if (
    panel === "preferences" &&
    (detail === "voice-changelog" || detail === "voice-examples")
  ) {
    return "voice";
  }
  if (
    panel === "security" &&
    (detail === "vault" || detail === "session" || detail === "trusted-devices")
  ) {
    return detail;
  }
  if (
    panel === "gmail" &&
    (detail === "gmail-connection" || detail === "gmail-actions")
  ) {
    return detail;
  }
  if (panel === "support" && detail === "support-routing") {
    return detail;
  }
  if (panel === "legal" && (detail === "terms" || detail === "privacy")) {
    return detail;
  }
  if (panel === "support" && detail.startsWith("support-compose:")) {
    const kind = normalizeSupportMessageKind(
      detail.slice("support-compose:".length),
    );
    return kind ? `support-compose:${kind}` : null;
  }

  return null;
}

function normalizeLegacyTab(value: string | null): ProfilePanel | null {
  if (value === "my-data") return "my-data";
  // "access"/"privacy" were the standalone Access & sharing panel; it is now
  // the Sharing sub-view of the unified Memory panel.
  if (value === "access" || value === "privacy") return "my-data";
  if (value === "connected-systems" || value === "systems") {
    return "connected-systems";
  }
  if (value === "account") return "account";
  if (value === "preferences") return "preferences";
  if (value === "security") return "security";
  return null;
}

function toSearchParams(
  searchParams?: SearchParamReader | URLSearchParams | string | null,
): URLSearchParams {
  if (!searchParams) return new URLSearchParams();
  if (searchParams instanceof URLSearchParams) {
    return new URLSearchParams(searchParams.toString());
  }
  if (typeof searchParams === "string") {
    const normalized = searchParams.startsWith("?")
      ? searchParams.slice(1)
      : searchParams;
    return new URLSearchParams(normalized);
  }
  return new URLSearchParams(searchParams.toString?.() ?? "");
}

function appendQuery(
  pathname: string,
  entries: Record<string, string | null | undefined>,
  preserveSearchParams?: SearchParamReader | URLSearchParams | string | null,
): string {
  const params = new URLSearchParams();
  const preserve = toSearchParams(preserveSearchParams);

  for (const key of TRANSIENT_PROFILE_QUERY_KEYS) {
    const value = preserve.get(key);
    if (value) params.set(key, value);
  }

  for (const [key, value] of Object.entries(entries)) {
    const normalized = String(value ?? "").trim();
    if (normalized) params.set(key, normalized);
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function normalizePathname(pathname: string): string {
  const [withoutQuery] = String(pathname || "").split("?");
  if (!withoutQuery || withoutQuery === "/") return withoutQuery || "/";
  return withoutQuery.replace(/\/+$/, "") || "/";
}

export function buildProfileRoute(params?: {
  panel?: ProfilePanel | null;
  detail?: ProfileDetail | null;
  searchParams?: SearchParamReader | URLSearchParams | string | null;
}): string {
  const panel = params?.panel ?? null;
  const detail = normalizeProfileDetail(panel, params?.detail ?? null);

  if (!panel) {
    return appendQuery(ROUTES.PROFILE, {}, params?.searchParams);
  }

  if (panel === "hosting" || panel === "software-updates") {
    return appendQuery(panel === "hosting" ? ROUTES.PROFILE_HOSTING : ROUTES.PROFILE_SOFTWARE_UPDATES, {}, params?.searchParams);
  }

  if (panel === "account") {
    return detail === "phone"
      ? appendQuery(ROUTES.PROFILE_ACCOUNT_PHONE, {}, params?.searchParams)
      : appendQuery(ROUTES.PROFILE_ACCOUNT, {}, params?.searchParams);
  }

  if (panel === "preferences") {
    if (detail === "kai-preferences") {
      return appendQuery(
        ROUTES.PROFILE_PREFERENCES_KAI,
        {},
        params?.searchParams,
      );
    }
    if (detail === "gemini") {
      return appendQuery(
        ROUTES.PROFILE_PREFERENCES_GEMINI,
        {},
        params?.searchParams,
      );
    }
    if (detail === "device") {
      return appendQuery(
        ROUTES.PROFILE_PREFERENCES_DEVICE,
        {},
        params?.searchParams,
      );
    }
    if (detail === "voice") {
      return appendQuery(
        ROUTES.PROFILE_PREFERENCES_VOICE,
        {},
        params?.searchParams,
      );
    }
    return appendQuery(ROUTES.PROFILE_PREFERENCES, {}, params?.searchParams);
  }

  if (panel === "security") {
    // Trusted devices is intentionally pane-only. Route-level callers fall
    // back to the security parent instead of generating the retired page URL;
    // the recursive sheet uses buildProfilePaneHref for the detail itself.
    if (detail === "trusted-devices") {
      return appendQuery(ROUTES.PROFILE_SECURITY, {}, params?.searchParams);
    }
    if (detail === "vault") {
      return appendQuery(
        ROUTES.PROFILE_SECURITY_VAULT,
        {},
        params?.searchParams,
      );
    }
    if (detail === "session") {
      return appendQuery(
        ROUTES.PROFILE_SECURITY_SESSION,
        {},
        params?.searchParams,
      );
    }
    return appendQuery(ROUTES.PROFILE_SECURITY, {}, params?.searchParams);
  }

  if (panel === "my-data") {
    if (detail?.startsWith("domain:")) {
      return appendQuery(
        ROUTES.PROFILE_MY_DATA_DOMAIN,
        { key: detail.slice("domain:".length) },
        params?.searchParams,
      );
    }
    // Sharing and its per-connection detail keep the legacy
    // /one/profile/access URLs so existing deep links stay valid.
    if (detail?.startsWith("connection:")) {
      return appendQuery(
        ROUTES.PROFILE_ACCESS_CONNECTION,
        { id: detail.slice("connection:".length) },
        params?.searchParams,
      );
    }
    if (detail === "sharing") {
      return appendQuery(ROUTES.PROFILE_ACCESS, {}, params?.searchParams);
    }
    return appendQuery(ROUTES.PROFILE_MY_DATA, {}, params?.searchParams);
  }

  if (panel === "connected-systems") {
    return appendQuery(
      ROUTES.PROFILE_CONNECTED_SYSTEMS,
      {},
      params?.searchParams,
    );
  }

  if (panel === "connectors") {
    return appendQuery(
      ROUTES.PROFILE_CONNECTORS,
      {
        connector: detail?.startsWith("connector:")
          ? detail.slice("connector:".length)
          : null,
      },
      params?.searchParams,
    );
  }

  if (panel === "gmail") {
    return appendQuery(ROUTES.GMAIL, {}, params?.searchParams);
  }

  if (panel === "referrals") {
    return appendQuery(ROUTES.PROFILE_REFERRALS, {}, params?.searchParams);
  }

  // Legal has no section route of its own. The Profile address carries it,
  // and that address opens the Profile pane on the document. The public
  // /terms and /privacy pages stay the signed-out and store-listing addresses.
  if (panel === "legal") {
    return appendQuery(
      ROUTES.PROFILE,
      { panel: "legal", detail },
      params?.searchParams,
    );
  }

  if (panel === "support") {
    if (detail === "support-routing") {
      return appendQuery(ROUTES.PROFILE_SUPPORT, {}, params?.searchParams);
    }
    if (detail?.startsWith("support-compose:")) {
      return appendQuery(
        ROUTES.PROFILE_SUPPORT,
        { kind: detail.slice("support-compose:".length) },
        params?.searchParams,
      );
    }
    return appendQuery(ROUTES.PROFILE_SUPPORT, {}, params?.searchParams);
  }

  return appendQuery(ROUTES.PROFILE, {}, params?.searchParams);
}

export function resolveProfileRouteStateFromSearchParams(
  searchParams?: SearchParamReader | URLSearchParams | string | null,
): ProfileRouteState {
  const query = toSearchParams(searchParams);
  const panel =
    normalizeProfilePanel(query.get("panel")) ??
    // Legacy ?panel=access / ?panel=privacy deep links fold into Memory.
    normalizeLegacyTab(query.get("panel")) ??
    normalizeLegacyTab(query.get("tab"));

  return {
    panel,
    detail: normalizeProfileDetail(panel, query.get("detail")),
  };
}

export function resolveProfileRouteState(
  pathname: string,
  searchParams?: SearchParamReader | URLSearchParams | string | null,
): ProfileRouteState {
  const [rawPathname = "", rawQuery = ""] = String(pathname || "").split("?");
  const query =
    searchParams === undefined
      ? new URLSearchParams(rawQuery)
      : toSearchParams(searchParams);
  const normalizedPath = normalizePathname(rawPathname);
  if (normalizedPath === ROUTES.PROFILE_HOSTING) return { panel: "hosting", detail: null };
  if (normalizedPath === ROUTES.PROFILE_SOFTWARE_UPDATES) return { panel: "software-updates", detail: null };

  if (normalizedPath === ROUTES.PROFILE) {
    return resolveProfileRouteStateFromSearchParams(query);
  }

  if (normalizedPath === ROUTES.PROFILE_ACCOUNT) {
    return { panel: "account", detail: null };
  }
  if (normalizedPath === ROUTES.PROFILE_ACCOUNT_PHONE) {
    return { panel: "account", detail: "phone" };
  }

  if (normalizedPath === ROUTES.PROFILE_PREFERENCES) {
    return { panel: "preferences", detail: null };
  }
  if (normalizedPath === ROUTES.PROFILE_PREFERENCES_KAI) {
    return { panel: "preferences", detail: "kai-preferences" };
  }
  if (normalizedPath === ROUTES.PROFILE_PREFERENCES_GEMINI) {
    return { panel: "preferences", detail: "gemini" };
  }
  if (normalizedPath === ROUTES.PROFILE_PREFERENCES_DEVICE) {
    return { panel: "preferences", detail: "device" };
  }
  if (normalizedPath === ROUTES.PROFILE_PREFERENCES_VOICE) {
    return { panel: "preferences", detail: "voice" };
  }
  if (normalizedPath === ROUTES.PROFILE_PREFERENCES_VOICE_CHANGELOG) {
    return { panel: "preferences", detail: "voice" };
  }
  if (normalizedPath === ROUTES.PROFILE_PREFERENCES_VOICE_EXAMPLES) {
    return { panel: "preferences", detail: "voice" };
  }

  if (normalizedPath === ROUTES.PROFILE_SECURITY) {
    return { panel: "security", detail: null };
  }
  if (normalizedPath === ROUTES.PROFILE_SECURITY_VAULT) {
    return { panel: "security", detail: "vault" };
  }
  if (normalizedPath === ROUTES.PROFILE_SECURITY_SESSION) {
    return { panel: "security", detail: "session" };
  }

  if (normalizedPath === ROUTES.PROFILE_MY_DATA) {
    return { panel: "my-data", detail: null };
  }
  if (normalizedPath === ROUTES.PROFILE_MY_DATA_DOMAIN) {
    const domainKey = query.get("key");
    return {
      panel: "my-data",
      detail: domainKey ? `domain:${domainKey}` : null,
    };
  }

  if (normalizedPath === ROUTES.PROFILE_ACCESS) {
    return { panel: "my-data", detail: "sharing" };
  }
  if (normalizedPath === ROUTES.PROFILE_ACCESS_CONNECTION) {
    const connectionId = query.get("id");
    return {
      panel: "my-data",
      detail: connectionId ? `connection:${connectionId}` : "sharing",
    };
  }

  if (normalizedPath === ROUTES.PROFILE_CONNECTED_SYSTEMS) {
    return { panel: "connected-systems", detail: null };
  }

  if (normalizedPath === ROUTES.PROFILE_CONNECTORS) {
    const connectorId = normalizeConnectorDetailId(query.get("connector"));
    return {
      panel: "connectors",
      detail: connectorId ? `connector:${connectorId}` : null,
    };
  }

  if (normalizedPath === ROUTES.PROFILE_GMAIL) {
    return { panel: "gmail", detail: null };
  }
  if (normalizedPath === ROUTES.PROFILE_GMAIL_CONNECTION) {
    return { panel: "gmail", detail: "gmail-connection" };
  }
  if (normalizedPath === ROUTES.PROFILE_GMAIL_ACTIONS) {
    return { panel: "gmail", detail: "gmail-actions" };
  }

  if (normalizedPath === ROUTES.PROFILE_REFERRALS) {
    return { panel: "referrals", detail: null };
  }

  if (normalizedPath === ROUTES.PROFILE_SUPPORT) {
    return { panel: "support", detail: null };
  }
  if (normalizedPath === ROUTES.PROFILE_SUPPORT_ROUTING) {
    return { panel: "support", detail: "support-routing" };
  }
  if (normalizedPath === ROUTES.PROFILE_SUPPORT_COMPOSE) {
    const kind = normalizeSupportMessageKind(query.get("kind"));
    return {
      panel: "support",
      detail: kind ? `support-compose:${kind}` : null,
    };
  }

  return { panel: null, detail: null };
}

export function buildCanonicalProfileRouteFromLegacyQuery(
  pathname: string,
  searchParams?: SearchParamReader | URLSearchParams | string | null,
): string | null {
  const normalizedPath = normalizePathname(pathname);
  if (normalizedPath !== ROUTES.PROFILE) return null;

  const query = toSearchParams(searchParams);
  const hasLegacyRouteState =
    query.has("panel") || query.has("detail") || query.has("tab");
  if (!hasLegacyRouteState) return null;

  const state = resolveProfileRouteStateFromSearchParams(query);
  const href = buildProfileRoute({
    panel: state.panel,
    detail: state.detail,
    searchParams: query,
  });

  const current = appendQuery(ROUTES.PROFILE, Object.fromEntries(query), null);
  return href === current ? null : href;
}

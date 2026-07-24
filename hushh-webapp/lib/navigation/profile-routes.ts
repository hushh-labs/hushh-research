import type { SupportMessageKind } from "@/lib/services/support-service";

import { ROUTES } from "@/lib/navigation/routes";

export type ProfilePanel =
  | "account"
  | "my-data"
  | "access"
  | "connected-systems"
  | "preferences"
  | "security"
  | "support"
  | "gmail"
  | "regulatory";

export type ProfileDetail =
  | `domain:${string}`
  | `connection:${string}`
  | "phone"
  | "kai-preferences"
  | "device"
  | "vault"
  | "session"
  | "gmail-connection"
  | "gmail-actions"
  | "support-routing"
  | `support-compose:${SupportMessageKind}`;

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


export function normalizeProfilePanel(value: string | null): ProfilePanel | null {
  if (
    value === "account" ||
    value === "my-data" ||
    value === "access" ||
    value === "connected-systems" ||
    value === "preferences" ||
    value === "security" ||
    value === "support" ||
    value === "gmail" ||
    value === "regulatory"
  ) {
    return value;
  }
  return null;
}

function normalizeSupportMessageKind(value: string | null): SupportMessageKind | null {
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
  if (panel === "access" && detail.startsWith("connection:")) {
    return detail as ProfileDetail;
  }
  if (panel === "account" && detail === "phone") {
    return detail;
  }
  if (
    panel === "preferences" &&
    (detail === "kai-preferences" || detail === "device")
  ) {
    return detail;
  }
  if (panel === "security" && (detail === "vault" || detail === "session")) {
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
  if (value === "access" || value === "privacy") return "access";
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

  if (panel === "account") {
    return detail === "phone"
      ? appendQuery(ROUTES.PROFILE_ACCOUNT_PHONE, {}, params?.searchParams)
      : appendQuery(ROUTES.PROFILE_ACCOUNT, {}, params?.searchParams);
  }

  if (panel === "preferences") {
    if (detail === "kai-preferences") {
      return appendQuery(ROUTES.PROFILE_PREFERENCES_KAI, {}, params?.searchParams);
    }
    if (detail === "device") {
      return appendQuery(ROUTES.PROFILE_PREFERENCES_DEVICE, {}, params?.searchParams);
    }
    return appendQuery(ROUTES.PROFILE_PREFERENCES, {}, params?.searchParams);
  }

  if (panel === "security") {
    if (detail === "vault") {
      return appendQuery(ROUTES.PROFILE_SECURITY_VAULT, {}, params?.searchParams);
    }
    if (detail === "session") {
      return appendQuery(ROUTES.PROFILE_SECURITY_SESSION, {}, params?.searchParams);
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
    return appendQuery(ROUTES.PROFILE_MY_DATA, {}, params?.searchParams);
  }

  if (panel === "access") {
    if (detail?.startsWith("connection:")) {
      return appendQuery(
        ROUTES.PROFILE_ACCESS_CONNECTION,
        { id: detail.slice("connection:".length) },
        params?.searchParams,
      );
    }
    return appendQuery(ROUTES.PROFILE_ACCESS, {}, params?.searchParams);
  }

  if (panel === "connected-systems") {
    return appendQuery(ROUTES.PROFILE_CONNECTED_SYSTEMS, {}, params?.searchParams);
  }

  if (panel === "gmail") {
    return appendQuery(ROUTES.GMAIL, {}, params?.searchParams);
  }

  if (panel === "support") {
    if (detail === "support-routing") {
      return appendQuery(ROUTES.PROFILE_SUPPORT_ROUTING, {}, params?.searchParams);
    }
    if (detail?.startsWith("support-compose:")) {
      return appendQuery(
        ROUTES.PROFILE_SUPPORT_COMPOSE,
        { kind: detail.slice("support-compose:".length) },
        params?.searchParams,
      );
    }
    return appendQuery(ROUTES.PROFILE_SUPPORT, {}, params?.searchParams);
  }

  if (panel === "regulatory") {
    return appendQuery(ROUTES.PROFILE_REGULATORY, {}, params?.searchParams);
  }

  return appendQuery(ROUTES.PROFILE, {}, params?.searchParams);
}

export function resolveProfileRouteStateFromSearchParams(
  searchParams?: SearchParamReader | URLSearchParams | string | null,
): ProfileRouteState {
  const query = toSearchParams(searchParams);
  const panel =
    normalizeProfilePanel(query.get("panel")) ??
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

  if (normalizedPath === ROUTES.PROFILE) {
    return resolveProfileRouteStateFromSearchParams(query);
  }

  if (normalizedPath === ROUTES.PROFILE_REGULATORY) {
    return { panel: "regulatory", detail: null };
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
  if (normalizedPath === ROUTES.PROFILE_PREFERENCES_DEVICE) {
    return { panel: "preferences", detail: "device" };
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
    return { panel: "access", detail: null };
  }
  if (normalizedPath === ROUTES.PROFILE_ACCESS_CONNECTION) {
    const connectionId = query.get("id");
    return {
      panel: "access",
      detail: connectionId ? `connection:${connectionId}` : null,
    };
  }

  if (normalizedPath === ROUTES.PROFILE_CONNECTED_SYSTEMS) {
    return { panel: "connected-systems", detail: null };
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

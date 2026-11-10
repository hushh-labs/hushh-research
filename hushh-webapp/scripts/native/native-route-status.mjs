const REQUIRED_ROUTE_AUDIT_STATUS_KEYS = Object.freeze([
  "route",
  "ready",
  "marker",
  "auth",
  "data",
  "doc",
  "found",
  "routeok",
]);

const ROUTE_AUDIT_PROGRESS_KEYS = Object.freeze([
  "route",
  "ready",
  "marker",
  "auth",
  "data",
  "doc",
  "found",
  "routeok",
  "bootstrap",
]);

export function parseNativeRouteAuditStatus(raw) {
  return Object.fromEntries(
    String(raw || "")
      .trim()
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const [key, ...rest] = part.split("=");
        return [key, rest.join("=")];
      }),
  );
}

/**
 * Native writes status to a file while the host polls it. A concurrent read
 * can observe an intermediate write, which must never refresh the watchdog.
 */
export function isCompleteNativeRouteAuditStatus(
  status,
  { requiresVaultBootstrap = false } = {},
) {
  const requiredKeys = requiresVaultBootstrap
    ? [...REQUIRED_ROUTE_AUDIT_STATUS_KEYS, "bootstrap"]
    : REQUIRED_ROUTE_AUDIT_STATUS_KEYS;
  return requiredKeys.every(
    (key) => typeof status?.[key] === "string" && status[key].length > 0,
  );
}

export function nativeRouteAuditProgressKey(status) {
  return ROUTE_AUDIT_PROGRESS_KEYS.map((key) => status[key]).join("|");
}

function normalizedRoutePath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return "/";
  try {
    const url = new URL(trimmed, "https://native-test.local");
    const pathname = url.pathname || "/";
    return pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  } catch {
    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  }
}

/**
 * Route reports strip query values for privacy. `routeok` is computed natively
 * against the full, unsanitized URL; the report gate checks that verdict and
 * confirms the sanitized pathname still belongs to the expected route.
 */
export function nativeRouteReportMatches(observed, route) {
  if ((observed?.routeok || "") !== "1") return false;
  const actualPath = normalizedRoutePath(observed?.route);
  if (route?.expectedRoute) {
    return actualPath === normalizedRoutePath(route.expectedRoute);
  }
  if (route?.expectedRoutePrefix) {
    const expectedPrefix = normalizedRoutePath(route.expectedRoutePrefix);
    return expectedPrefix === "/"
      ? actualPath.startsWith("/")
      : actualPath === expectedPrefix || actualPath.startsWith(`${expectedPrefix}/`);
  }
  return true;
}

export function hasNativeRouteAuditContract(route) {
  const auth = route?.allowedAuthStates === undefined
    ? [route?.expectedAuth]
    : route.allowedAuthStates;
  const populatedStrings = (values) =>
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => typeof value === "string" && value.trim().length > 0);
  return populatedStrings(auth) && populatedStrings(route?.allowedDataStates);
}

/**
 * Once the authenticated, unlocked document is complete, a wrong route or
 * marker is a contract failure—not an app bootstrap state worth waiting on.
 */
export function isSettledNativeRouteAuditSurface(status, route) {
  if (!hasNativeRouteAuditContract(route)) return false;
  const allowedAuthStates = route.allowedAuthStates || [route.expectedAuth];
  return (
    allowedAuthStates.includes(status.auth) &&
    route.allowedDataStates.includes(status.data) &&
    status.doc === "complete" &&
    status.found === "1" &&
    (!allowedAuthStates.includes("authenticated") || status.bootstrap === "vault_unlocked")
  );
}

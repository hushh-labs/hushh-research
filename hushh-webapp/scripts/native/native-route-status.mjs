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

/**
 * Once the authenticated, unlocked document is complete, a wrong route or
 * marker is a contract failure—not an app bootstrap state worth waiting on.
 */
export function isSettledNativeRouteAuditSurface(status, route) {
  return (
    status.auth === route.expectedAuth &&
    route.allowedDataStates.includes(status.data) &&
    status.doc === "complete" &&
    status.found === "1" &&
    (route.expectedAuth !== "authenticated" || status.bootstrap === "vault_unlocked")
  );
}

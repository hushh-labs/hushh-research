/**
 * The backend returns public-invite URLs as app-relative paths
 * (e.g. /one/location/view/<token>). Resolve them against the configured
 * app origin (NEXT_PUBLIC_APP_URL) or the current window origin so they can
 * be shared, copied, and autolinked outside the app.
 */

/**
 * Where a public live-location link opens today.
 *
 * The recipient reads this path before they decide whether to tap, so it has
 * to say what the page does. It shows a live location; it does not ask them
 * for anything.
 */
export const PUBLIC_LOCATION_VIEW_PREFIX = "/one/location/view";

/**
 * The prefix the same links carried before the rename. Still resolvable —
 * every link minted under it is already in somebody's chat — but nothing new
 * is ever minted here. `proxy.ts` redirects it, and the route itself forwards.
 */
export const LEGACY_PUBLIC_LOCATION_REQUEST_PREFIX = "/one/location/request";

/** The app-relative page for one public-invite token. */
export function publicLocationViewPath(token: string): string {
  return `${PUBLIC_LOCATION_VIEW_PREFIX}/${token}`;
}

/**
 * The `/view` form of a path that may still be written the old way.
 *
 * Applied to whatever the API hands back rather than trusting it: a link read
 * from a row minted before the rename, or a backend that has not rolled out
 * yet, would otherwise be copied and shared in the old shape long after the
 * app stopped producing it.
 */
export function canonicalPublicInvitePath(value: string): string {
  if (!value) return "";
  // Anchored on the path segment, not on a bare substring: a token is
  // base64url and can hold anything, and an origin can too, so replacing the
  // first occurrence anywhere in the string could rewrite the token itself.
  const legacyPattern = new RegExp(
    `(^|https?://[^/]+)${LEGACY_PUBLIC_LOCATION_REQUEST_PREFIX}(?=/|$)`,
    "i",
  );
  return value.replace(legacyPattern, `$1${PUBLIC_LOCATION_VIEW_PREFIX}`);
}

export function publicInviteUrlLabel(value: string): string {
  if (!value) return "";
  const configuredOrigin = String(process.env.NEXT_PUBLIC_APP_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const canonical = canonicalPublicInvitePath(value);
  if (/^https?:\/\//i.test(value)) return canonical;
  const origin =
    /^https?:\/\//i.test(configuredOrigin) ||
    typeof window === "undefined"
      ? configuredOrigin
      : String(window.location.origin || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(origin)) return canonical;
  return new URL(canonical, origin).toString();
}

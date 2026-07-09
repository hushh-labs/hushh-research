/**
 * The backend returns public-invite URLs as app-relative paths
 * (e.g. /one/location/request/<token>). Resolve them against the configured
 * app origin (NEXT_PUBLIC_APP_URL) or the current window origin so they can
 * be shared, copied, and autolinked outside the app.
 */
export function publicInviteUrlLabel(value: string): string {
  if (!value) return "";
  const configuredOrigin = String(process.env.NEXT_PUBLIC_APP_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (/^https?:\/\//i.test(value)) return value;
  const origin =
    /^https?:\/\//i.test(configuredOrigin) ||
    typeof window === "undefined"
      ? configuredOrigin
      : String(window.location.origin || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(origin)) return value;
  return new URL(value, origin).toString();
}

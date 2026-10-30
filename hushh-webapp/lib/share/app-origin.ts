/**
 * The origin a link has to carry when it leaves the app.
 *
 * Extracted from `lib/one-location/circle-join-url.ts`, where this was written
 * first and named after the one link that needed it. Nothing about it is
 * Circle-specific, and the trap it exists to avoid is the kind that is only
 * found once: Capacitor does not serve the installed app from a web origin --
 * iOS runs on the custom `App://localhost` scheme (`ios.scheme` in
 * capacitor.config.ts) and Android on `https://localhost` -- so a second
 * surface that reached for `window.location.origin` would ship a link that is
 * dead for everybody who receives it, and would look correct in every browser
 * test. One copy, shared.
 */

const WEB_ORIGIN = /^https?:\/\//i;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

/**
 * An origin only counts if the person receiving the link could open it.
 *
 * That rules out both Capacitor runtime origins -- `App://localhost` is
 * rejected on scheme, `https://localhost` on host, since it passes an http(s)
 * check but resolves to the recipient's own device.
 */
export function normalizeWebOrigin(
  value: string | null | undefined,
): string | null {
  const trimmed = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  if (!WEB_ORIGIN.test(trimmed)) return null;
  try {
    return LOOPBACK_HOST.test(new URL(trimmed).hostname) ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * The origin shared links point at.
 *
 * The live origin wins on the web, so a link shared from UAT keeps pointing at
 * UAT. Only when it is not a real web origin do we fall back to the origin
 * baked into the build (NEXT_PUBLIC_APP_URL, set by the TestFlight/App
 * Store/Play workflows). Returns null when neither is usable, which callers
 * read as "there is no link worth sharing" rather than papering over it with a
 * broken one.
 */
export function resolveShareableAppOrigin(): string | null {
  const live =
    typeof window === "undefined"
      ? null
      : normalizeWebOrigin(window.location?.origin);
  return live ?? normalizeWebOrigin(process.env.NEXT_PUBLIC_APP_URL);
}

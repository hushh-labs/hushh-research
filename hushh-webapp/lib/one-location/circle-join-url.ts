/**
 * Build a clickable Circle join link that carries the invite code, e.g.
 * `https://uat.one.hushh.ai/circle/join?code=96RE-HUNF-KMVX`.
 *
 * The `/circle/join` route reads the `code` query param and forwards into the
 * in-app "Join with code" flow with the field pre-filled, so a recipient can tap
 * the link instead of copy-pasting the raw code.
 */
export const CIRCLE_JOIN_CODE_PARAM = "code";

/**
 * Group a code the way it is shown everywhere else (`96RE-HUNF-KMVX`).
 *
 * A link can carry the code in any casing or spacing, so the landing page
 * normalises before grouping -- a code pasted from a message should look
 * identical to the one the sender is reading off their own screen.
 */
export function formatCircleCodeForDisplay(raw: string): string {
  const normalized = String(raw || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  return normalized.replace(/(.{4})(?=.)/g, "$1-");
}

const WEB_ORIGIN = /^https?:\/\//i;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

/**
 * An origin only counts if the person receiving the invite could open it.
 *
 * That rules out Capacitor's two runtime origins -- `App://localhost` on iOS
 * (rejected on scheme) and `https://localhost` on Android (rejected on host,
 * since it passes an http(s) check but resolves to the recipient's own device).
 */
function normalizeWebOrigin(value: string | null | undefined): string | null {
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
 * The origin a shared join link must point at.
 *
 * Capacitor does not serve the installed app from a web origin: iOS runs on the
 * custom `App://localhost` scheme (`ios.scheme` in capacitor.config.ts) and
 * Android on `https://localhost`. Sharing `window.location.origin` from a device
 * therefore delivered `App://localhost/circle/join?code=...` -- a link that is
 * dead for whoever receives it, which is why the invite only ever worked when
 * shared from a browser.
 *
 * The live origin still wins on the web so a UAT invite keeps pointing at UAT.
 * Only when it is not a real web origin do we fall back to the origin baked into
 * the build (NEXT_PUBLIC_APP_URL, set by the TestFlight/App Store/Play
 * workflows). Returns null when neither is usable, which makes callers share the
 * code on its own rather than a broken link.
 */
export function resolveCircleJoinOrigin(): string | null {
  const live =
    typeof window === "undefined"
      ? null
      : normalizeWebOrigin(window.location?.origin);
  return live ?? normalizeWebOrigin(process.env.NEXT_PUBLIC_APP_URL);
}

export function buildCircleJoinUrl(origin: string, code: string): string {
  const base = String(origin || "").replace(/\/+$/, "");
  const trimmedCode = String(code || "").trim();
  const query = trimmedCode
    ? `?${CIRCLE_JOIN_CODE_PARAM}=${encodeURIComponent(trimmedCode)}`
    : "";
  return `${base}/circle/join${query}`;
}

"use strict";

/**
 * Known marketing / click-tracking query-parameter names and prefixes.
 * Any parameter whose name matches this pattern is stripped before the
 * URL is forwarded, logged, or stored.
 *
 *   utm_*    — Google Analytics campaign suite (any utm_ prefix)
 *   gclid    — Google Ads click identifier
 *   fbclid   — Facebook / Meta click identifier
 *   msclkid  — Microsoft / Bing Ads click identifier
 *   ttclid   — TikTok Ads click identifier
 *   twclid   — Twitter / X Ads click identifier
 *   dclid    — DoubleClick / Google Display & Video 360
 *   yclid    — Yandex click identifier
 *   igshid   — Instagram share identifier
 *   mc_cid   — Mailchimp campaign identifier
 *   mc_eid   — Mailchimp email identifier
 *   srsltid  — Google Shopping result-listing identifier
 */
const TRACKING_PATTERN =
  /^(utm_|gclid|fbclid|msclkid|ttclid|twclid|dclid|yclid|igshid|mc_cid|mc_eid|srsltid)/i;

/**
 * Synthetic base used only when parsing relative URLs through the WHATWG
 * URL API.  Chosen to be obviously non-real so it is never confused with a
 * live origin.
 */
const _DUMMY_BASE = "https://__scrubber_placeholder__.invalid";

/**
 * scrubTrackingParams(urlText)
 *
 * Strips marketing and click-tracking query parameters from a URL string
 * while leaving all functional parameters intact.
 *
 * Behaviour summary:
 *
 *   Absolute URL  (https://…)   →  parsed, scrubbed, returned as-is
 *   Relative path (/path?…)     →  parsed with dummy base, path+query+
 *                                   fragment returned (origin dropped)
 *   Unparseable string           →  raw input returned unchanged
 *   Non-string / null / undefined →  empty string returned
 *   Empty / whitespace-only      →  empty string returned
 *
 * The relative-URL fallback is intentionally restricted to inputs that
 * start with "/" to avoid silently URL-encoding arbitrary plain strings
 * through the WHATWG relative-URL parser.
 *
 * @param  {string} urlText
 * @returns {string}
 */
function scrubTrackingParams(urlText) {
  if (typeof urlText !== "string") return "";

  const trimmed = urlText.trim();
  if (!trimmed) return "";

  let parsed;
  let isRelative = false;

  // ── Attempt 1: parse as an absolute URL ───────────────────────────────────
  try {
    parsed = new URL(trimmed);
  } catch {
    // ── Attempt 2: parse as a relative path (only when starting with /) ─────
    if (trimmed.startsWith("/")) {
      try {
        parsed = new URL(trimmed, _DUMMY_BASE);
        isRelative = true;
      } catch {
        return trimmed; // still unparseable — return raw
      }
    } else {
      // Not an absolute URL and not a recognisable path — return raw unchanged
      return trimmed;
    }
  }

  // ── Strip tracking parameters ─────────────────────────────────────────────
  const toDelete = [];
  for (const key of parsed.searchParams.keys()) {
    if (TRACKING_PATTERN.test(key)) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    parsed.searchParams.delete(key);
  }

  // ── Reconstruct ───────────────────────────────────────────────────────────
  if (isRelative) {
    const qs = parsed.searchParams.toString();
    return parsed.pathname + (qs ? `?${qs}` : "") + parsed.hash;
  }

  return parsed.toString();
}

module.exports = { scrubTrackingParams };

"use strict";

/**
 * Query-parameter names (or prefixes) that are known marketing/click-
 * tracking markers and must be stripped before a URL is forwarded,
 * logged, or stored.
 *
 * Covered trackers:
 *   utm_*    — Google Analytics campaign parameters (any utm_ prefix)
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
 *   srsltid  — Google Shopping result listing identifier
 */
const TRACKING_PATTERN = /^(utm_|gclid|fbclid|msclkid|ttclid|twclid|dclid|yclid|igshid|mc_cid|mc_eid|srsltid)/i;

/**
 * A placeholder base used to parse relative URLs via the WHATWG URL API.
 * Chosen to be obviously synthetic so it is never confused with real origins.
 */
const _DUMMY_BASE = "https://__scrubber_placeholder__.invalid";

/**
 * scrubTrackingParams(urlText)
 *
 * Strips marketing and click-tracking query parameters from a URL string
 * while leaving all functional parameters intact.
 *
 * Behaviour:
 *   - Absolute URLs   (https://…)  →  parsed, scrubbed, returned as string
 *   - Relative URLs   (/path?…)    →  parsed with dummy base, path+query+
 *                                     hash returned (origin dropped)
 *   - Unparseable strings           →  raw input returned unchanged
 *   - Non-string / null / undefined →  empty string returned
 *   - Empty string                  →  empty string returned
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

  // ── Attempt 1: treat as absolute URL ──────────────────────────────────────
  try {
    parsed = new URL(trimmed);
  } catch {
    // ── Attempt 2: treat as a relative path (must start with / or //) ──────
    // We restrict this fallback to inputs that look like URL paths to avoid
    // silently mangling arbitrary strings (e.g. "not a url") by URL-encoding
    // them through the WHATWG relative-URL parser.
    if (trimmed.startsWith("/")) {
      try {
        parsed = new URL(trimmed, _DUMMY_BASE);
        isRelative = true;
      } catch {
        return trimmed;
      }
    } else {
      // Unparseable and not a recognisable path — return raw input unchanged
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

  // ── Reconstruct the URL ───────────────────────────────────────────────────
  if (isRelative) {
    const qs = parsed.searchParams.toString();
    return parsed.pathname + (qs ? `?${qs}` : "") + parsed.hash;
  }

  return parsed.toString();
}

module.exports = { scrubTrackingParams };

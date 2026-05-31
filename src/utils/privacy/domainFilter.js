"use strict";

/**
 * Builds a normalised lookup Set from a whitelist array.
 * Non-string entries and blank strings are silently skipped.
 * Every retained entry is lower-cased and whitespace-trimmed.
 *
 * @param  {Array} whitelist
 * @returns {Set<string>}
 */
function buildWhitelistSet(whitelist) {
  const set = new Set();
  for (const entry of whitelist) {
    if (typeof entry !== "string") continue;
    const normalised = entry.trim().toLowerCase();
    if (normalised.length > 0) set.add(normalised);
  }
  return set;
}

/**
 * filterWhitelistedDomains(domainArray, allowedWhitelist)
 *
 * Scrubs an array of outbound logging destination domains against an
 * authorised whitelist to enforce strict user-data privacy consent
 * boundaries.  Only domains that appear in the whitelist are retained.
 *
 * Matching rules:
 *   - Comparison is case-insensitive ("HUSHH.AI" matches "hushh.ai")
 *   - Leading/trailing whitespace is trimmed before comparison and from
 *     the returned values ("  hushh.ai  " → stored as "hushh.ai")
 *   - Non-string elements in either array are silently ignored
 *   - Blank strings (whitespace-only) are never matched or returned
 *
 * Safe-fallback rules (returns [] without throwing):
 *   - Either argument is null, undefined, or not an array
 *   - Either or both arrays are empty
 *
 * @param  {Array}    domainArray      — domains to evaluate
 * @param  {Array}    allowedWhitelist — authorised domain entries
 * @returns {string[]}                 — filtered, trimmed, whitelist-approved domains
 */
function filterWhitelistedDomains(domainArray, allowedWhitelist) {
  // ── Input validation ───────────────────────────────────────────────────────
  if (!Array.isArray(domainArray) || !Array.isArray(allowedWhitelist)) {
    return [];
  }

  // ── Fast exit for empty inputs ─────────────────────────────────────────────
  if (domainArray.length === 0 || allowedWhitelist.length === 0) {
    return [];
  }

  // ── Build O(1)-lookup Set from the whitelist ───────────────────────────────
  const whitelistSet = buildWhitelistSet(allowedWhitelist);

  // ── Filter domain array against the whitelist ──────────────────────────────
  const result = [];
  for (const domain of domainArray) {
    if (typeof domain !== "string") continue;
    const trimmed    = domain.trim();
    const normalised = trimmed.toLowerCase();
    if (normalised.length > 0 && whitelistSet.has(normalised)) {
      result.push(trimmed); // return trimmed but original-case form
    }
  }
  return result;
}

module.exports = { filterWhitelistedDomains };

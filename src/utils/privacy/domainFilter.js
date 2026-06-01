"use strict";

/**
 * Canonical outbound domain registry — the single source of truth for
 * destinations that are authorised to receive exported consent data or
 * outbound log payloads under the Hushh data-consent protocol.
 *
 * Every domain that crosses the consent export boundary must appear here.
 * Frozen at module load time to prevent accidental runtime mutation.
 */
const ALLOWED_OUTBOUND_DOMAINS = Object.freeze([
  "hushh.ai",
  "api.hushh.ai",
  "consent.hushh.ai",
  "vault.hushh.ai",
]);

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Builds a normalised O(1)-lookup Set from a whitelist array.
 * Non-string entries and blank strings are silently skipped.
 * Every retained entry is trimmed and lower-cased.
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

// ── Pure utility ───────────────────────────────────────────────────────────────

/**
 * filterWhitelistedDomains(domainArray, allowedWhitelist)
 *
 * Scrubs an array of destination domains against a caller-supplied whitelist.
 * Matching is case-insensitive and whitespace-trimmed on both sides.
 * Non-string elements in either array are silently skipped.
 * Returns [] (never throws) for null / non-array / empty inputs.
 *
 * @param  {Array}    domainArray      — domains to evaluate
 * @param  {Array}    allowedWhitelist — authorised domain entries
 * @returns {string[]}                 — trimmed, whitelist-approved domains
 */
function filterWhitelistedDomains(domainArray, allowedWhitelist) {
  if (!Array.isArray(domainArray) || !Array.isArray(allowedWhitelist)) {
    return [];
  }
  if (domainArray.length === 0 || allowedWhitelist.length === 0) {
    return [];
  }

  const whitelistSet = buildWhitelistSet(allowedWhitelist);
  const result = [];

  for (const domain of domainArray) {
    if (typeof domain !== "string") continue;
    const trimmed    = domain.trim();
    const normalised = trimmed.toLowerCase();
    if (normalised.length > 0 && whitelistSet.has(normalised)) {
      result.push(trimmed);
    }
  }
  return result;
}

// ── Wired outbound consent boundary ───────────────────────────────────────────

/**
 * filterOutboundDomains(domainArray)
 *
 * Wired variant of filterWhitelistedDomains that enforces the canonical
 * ALLOWED_OUTBOUND_DOMAINS registry at the consent export / outbound
 * routing boundary.
 *
 * This is the function that MUST be called at every outbound routing
 * decision point — not filterWhitelistedDomains directly — so that the
 * allowed-domain source of truth is always the registry above.
 *
 * @param  {Array}    domainArray — candidate destination domains
 * @returns {string[]}            — registry-approved destinations only
 */
function filterOutboundDomains(domainArray) {
  return filterWhitelistedDomains(domainArray, ALLOWED_OUTBOUND_DOMAINS);
}

module.exports = {
  filterOutboundDomains,      // wired public API — use at routing boundary
  filterWhitelistedDomains,   // pure utility — use when supplying a custom whitelist
  ALLOWED_OUTBOUND_DOMAINS,   // exported for inspection and test assertions
};

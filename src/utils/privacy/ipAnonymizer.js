"use strict";

/**
 * Neutral fallback returned for any input that cannot be parsed as a
 * recognisable IPv4 or IPv6 address.
 */
const FALLBACK = "0.0.0.0";

// ── IPv4 helpers ─────────────────────────────────────────────────────────────

/**
 * Validates and anonymises an IPv4 address by zeroing the host (last) octet.
 * Returns the anonymised string on success, or null if the input is not a
 * valid dotted-decimal IPv4 address.
 *
 * Validation rules:
 *   - Exactly 4 dot-separated segments
 *   - Each segment is a decimal integer 0–255 with no leading zeros
 */
function _tryIPv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;       // non-numeric segment
    const n = Number(part);
    if (n < 0 || n > 255) return null;           // out-of-range
    if (String(n) !== part) return null;          // leading zeros (e.g. "01")
  }

  return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

// ── IPv6 helpers ─────────────────────────────────────────────────────────────

/**
 * Expands a compressed IPv6 address (containing at most one "::") into an
 * array of exactly 8 lowercase hex group strings.
 * Returns null when the address is structurally invalid.
 */
function _expandIPv6(ip) {
  const doubleColonCount = (ip.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  let groups;

  if (doubleColonCount === 1) {
    const [left, right] = ip.split("::");
    const leftGroups  = left  ? left.split(":")  : [];
    const rightGroups = right ? right.split(":") : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 0) return null;
    groups = [...leftGroups, ...Array(missing).fill("0"), ...rightGroups];
  } else {
    groups = ip.split(":");
  }

  if (groups.length !== 8) return null;

  // Validate every group — must be 1–4 hex digits
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  }

  return groups;
}

/**
 * Validates and anonymises an IPv6 address by zeroing the last four groups
 * (the host/interface-identifier half of the /64 boundary), leaving the
 * first four groups (network prefix) intact.
 *
 * Returns the anonymised string on success, or null if the input is not a
 * valid IPv6 address.
 *
 * Output format: "<group0>:<group1>:<group2>:<group3>::"
 * Leading zeros are removed from each prefix group for readability.
 */
function _tryIPv6(ip) {
  if (!ip.includes(":")) return null;

  const groups = _expandIPv6(ip);
  if (!groups) return null;

  const prefix = groups
    .slice(0, 4)
    .map(g => parseInt(g, 16).toString(16))  // strip leading zeros
    .join(":");

  return `${prefix}::`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * anonymizeIP(ipAddress)
 *
 * Masks the host-identifying portion of an IP address to protect individual
 * user privacy in logs, analytics, and audit records.
 *
 * IPv4  →  zeroes the final (host) octet
 *           "192.168.1.45"            →  "192.168.1.0"
 *
 * IPv6  →  zeroes the last four groups (interface identifier)
 *           "2001:db8:85a3::8a2e:370:7334"  →  "2001:db8:85a3:0::"
 *           "fe80::1"                        →  "fe80:0:0:0::"
 *
 * Fallback "0.0.0.0" is returned — without throwing — for:
 *   - null / undefined input
 *   - non-string input
 *   - empty or whitespace-only strings
 *   - strings that are neither valid IPv4 nor valid IPv6
 *
 * @param  {string} ipAddress
 * @returns {string}  anonymised IP string, or "0.0.0.0" on invalid input
 */
function anonymizeIP(ipAddress) {
  if (typeof ipAddress !== "string" || ipAddress.trim() === "") {
    return FALLBACK;
  }

  const trimmed = ipAddress.trim();

  const ipv4 = _tryIPv4(trimmed);
  if (ipv4 !== null) return ipv4;

  const ipv6 = _tryIPv6(trimmed);
  if (ipv6 !== null) return ipv6;

  return FALLBACK;
}

module.exports = { anonymizeIP };

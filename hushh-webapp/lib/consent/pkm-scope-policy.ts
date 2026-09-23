/**
 * Consent-export policy for encrypted PKM source-artifact branches.
 * Mirrors the financial DomainSharingPolicy in
 * consent-protocol/hushh_mcp/services/domain_contracts.py; keep them equal.
 */

/** Private financial branches: raw per-connection copies and app state. */
const PRIVATE_FINANCIAL_PREFIXES = new Set(["analysis_history", "sources", "runtime"]);

const PRIVATE_ARTIFACT_PARTS = new Set([
  "agent_votes",
  "debate_transcript",
  "raw_card",
  "stream_diagnostics",
  "transcript",
  "account_mask",
  "mask",
  "account_number",
  "routing_number",
  "symbol_cusip",
  "cusip",
  "last_error_message",
]);

export function isPrivatePkmExportScope(scope: string): boolean {
  const parts = scope
    .split(".")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts[0] !== "attr" || parts[1] !== "financial") return false;
  const path = parts.slice(2).filter((part) => part !== "*");
  if (path.length === 0) return true;
  if (PRIVATE_FINANCIAL_PREFIXES.has(path[0] ?? "")) return true;
  return path.some((part) => PRIVATE_ARTIFACT_PARTS.has(part));
}

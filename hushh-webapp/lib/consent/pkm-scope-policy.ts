/**
 * Consent-export policy for encrypted PKM source-artifact branches.
 * Mirrors the financial DomainSharingPolicy in
 * consent-protocol/hushh_mcp/services/domain_contracts.py; keep them equal.
 */

/** Private financial branches: raw per-connection copies and app state. */
const PRIVATE_FINANCIAL_PREFIXES = new Set([
  "analysis_history",
  "sources",
  "runtime",
  // Zero-knowledge Plaid branches: vault-sealed raw records and private facts.
  "connections_v1",
  "accounts_v1",
  "holdings_v1",
  "securities_v1",
  "transactions_v1",
  "derived_v1",
  // Their readable view: the same account records, organised for browsing.
  "linked_accounts",
]);

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

const NON_EXTERNALIZABLE_PKM_DOMAINS = new Set([
  "one_memory",
  "one_living_sources",
  "one_todos",
  "source_library",
  "one_wiki",
  "secrets",
  "kyc_connector",
  "kyc_workflow",
  "runtime_secrets",
]);

const EXCLUDED_FULL_EXPORT_PKM_DOMAINS = new Set([
  ...NON_EXTERNALIZABLE_PKM_DOMAINS,
  "wallet",
]);

export function isNonExternalizablePkmDomain(domain: string): boolean {
  return NON_EXTERNALIZABLE_PKM_DOMAINS.has(domain.trim().toLowerCase());
}

export function isPrivatePkmExportScope(scope: string): boolean {
  const parts = scope
    .split(".")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (
    parts[0] === "attr" &&
    NON_EXTERNALIZABLE_PKM_DOMAINS.has(parts[1] || "")
  )
    return true;
  if (parts[0] === "attr" && parts[1] === "wallet") return !(parts.length === 4 && ["summary", "secrets"].includes(parts[2] || "") && parts[3] === "*");
  if (parts[0] !== "attr" || parts[1] !== "financial") return false;
  const path = parts.slice(2).filter((part) => part !== "*");
  if (path.length === 0) return true;
  if (PRIVATE_FINANCIAL_PREFIXES.has(path[0] ?? "")) return true;
  return path.some((part) => PRIVATE_ARTIFACT_PARTS.has(part));
}

/** Root legacy exports cannot route around a domain's private boundary. */
export function excludePrivatePkmDomains(
  fullBlob: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fullBlob).filter(
      ([domain]) =>
        !EXCLUDED_FULL_EXPORT_PKM_DOMAINS.has(domain.trim().toLowerCase()),
    ),
  );
}

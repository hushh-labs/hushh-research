import type { Holding } from "@/components/kai/types/portfolio";
import { groupHoldingPositions } from "@/lib/kai/holding-positions";
import { buildFinancialDomainSummary, buildStatementSource, getActiveSource, getStatementPortfolio, getStatementSnapshots } from "./financial-sources";
import { CURRENT_PKM_CONTRACT_VERSION, comparePkmSemanticVersions } from "@/lib/personal-knowledge-model/upgrade-contracts";
import { upsertStatementSnapshot } from "./statement-import-identity";

type RecordValue = Record<string, unknown>;
type ImportPortfolio = { holdings?: Holding[]; account_info?: { account_number?: string; brokerage?: string } };
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const signature = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function contentSignature(value: unknown): string {
  const portfolio = record(value);
  const { updated_at: _updatedAt, ...intent } = record(portfolio.domain_intent);
  return signature({ ...portfolio, domain_intent: intent });
}

/** Counts describe the committed portfolio replacement, never parser intentions. */
function importResult(current: RecordValue, portfolio: ImportPortfolio, operationId: string, now: string, skipped: number) {
  const previous = getStatementPortfolio(current);
  const next = groupHoldingPositions(portfolio.holdings ?? []);
  const before = groupHoldingPositions(previous?.holdings ?? []);
  const priorSnapshots = getStatementSnapshots(current);
  const priorRaw = record(current.portfolio).holdings;
  const source = record(record(current.portfolio).source_metadata);
  const sameSource = (source.active_snapshot_id || source.source_id) === operationId;
  const noPriorPortfolio = current.portfolio === undefined && current.sources === undefined && !priorSnapshots.length;
  const completeBaseline = Array.isArray(priorRaw) && priorRaw.length === previous?.holdings?.length;
  const identitiesKnown = [...next, ...before].every(position =>
    ["ticker", "cusip"].includes(position.identifier_type ?? "") && Boolean(position.symbol));
  const comparable = identitiesKnown && (noPriorPortfolio ||
    (sameSource && completeBaseline && getActiveSource(current) === "statement"));
  const oldPositions = new Map(before.map(position => [position.client_id, position]));
  let added = 0, updated = 0, unchanged = 0;
  if (comparable) for (const position of next) {
    const old = oldPositions.get(position.client_id);
    if (!old) added++;
    else if (signature(old.entries) === signature(position.entries)) unchanged++;
    else updated++;
  }
  return { operation_id: operationId, state: "saved", confirmed_at: now,
    holdings_saved: next.length, entries_saved: portfolio.holdings?.length ?? 0,
    added: comparable ? added : null, updated: comparable ? updated : null,
    unchanged: comparable ? unchanged : null, skipped_entries: skipped, failed: 0,
    counts_available: comparable, atomic: true };
}

/** Invoked for every coordinator attempt so a retry preserves the winning revision. */
export function buildStatementImportWrite(params: {
  current: RecordValue | null; snapshot: RecordValue; portfolio: ImportPortfolio;
  analytics: unknown; summary: RecordValue; now: string; skipped: number;
}) {
  const { snapshot, portfolio, analytics, summary, now, skipped } = params;
  const current = params.current ?? {};
  if (comparePkmSemanticVersions(String(current.pkm_contract_version ?? "0"), CURRENT_PKM_CONTRACT_VERSION) > 0 || current.financial_core_v7) {
    throw new Error("Update One before saving this upgraded portfolio.");
  }
  const documents = record(current.documents);
  const snapshotId = String(snapshot.id);
  const old = getStatementSnapshots(current).find(item => item.id === snapshotId);
  const replay = old && contentSignature(old.canonical_v2) === contentSignature(snapshot.canonical_v2);
  const committedSnapshot = { ...snapshot,
    imported_at: replay && old.imported_at ? old.imported_at : snapshot.imported_at,
    import_result: replay && old.import_result ? old.import_result : importResult(current, portfolio, snapshotId, now, skipped) };
  const snapshots = upsertStatementSnapshot(getStatementSnapshots(current), committedSnapshot);
  const domainData = { ...current, schema_version: 3,
    domain_intent: { primary: "financial", source: "domain_registry_prepopulate", contract_version: 2, updated_at: now },
    portfolio, analytics: analytics || current.analytics || null,
    documents: { ...documents, schema_version: 1, statements: snapshots, domain_intent: snapshot.domain_intent },
    sources: { ...record(current.sources), active_source: "statement",
      statement: buildStatementSource(current, snapshots, snapshotId, now) }, updated_at: now };
  const source = record(snapshot.source);
  return { domainData, summary: { ...buildFinancialDomainSummary(domainData), ...summary,
    documents_count: snapshots.length,
    last_statement_end: source.statement_period_end || documents.last_statement_end || null,
    last_brokerage: source.brokerage || documents.last_brokerage || null,
  }, mergeDecision: { merge_mode: "replace_domain", target_domain: "financial",
    match_reason: "Statement import replaces the active portfolio while preserving current financial records." } };
}

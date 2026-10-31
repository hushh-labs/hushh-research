import type { PortfolioData } from "@/components/kai/types/portfolio";
import { getActiveSource, getActiveStatementSnapshotId, getStatementPortfolio, getStatementSnapshots } from "./financial-sources";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function signature(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/** Build from the coordinator's current revision; never replace unrelated financial branches. */
export function applyStatementHoldingsEdit(
  financial: Record<string, unknown>, portfolio: PortfolioData, previous: PortfolioData,
  snapshotId: string | null, updatedAt: string,
): Record<string, unknown> {
  const current = getStatementPortfolio(financial);
  if (getActiveSource(financial) !== "statement" ||
    snapshotId !== getActiveStatementSnapshotId(financial) || !current ||
    signature(current.holdings) !== signature(previous.holdings) ||
    signature(current.account_summary) !== signature(previous.account_summary)) {
    throw new Error("This portfolio changed while you were editing. Reopen it before saving.");
  }
  const core = record(financial.financial_core_v7);
  if (String(financial.pkm_contract_version ?? "").startsWith("7.")) {
    const positions = { ...record(core.positions) };
    const securities = { ...record(core.securities) };
    const accountIds = Object.keys(record(core.accounts));
    for (const entry of previous.holdings ?? []) {
      if (entry.position_id) delete positions[entry.position_id];
    }
    for (const entry of portfolio.holdings ?? []) {
      const id = entry.position_id || entry.entry_id;
      if (!id) throw new Error("This entry has no saved identity. Reopen the portfolio and try again.");
      const accountId = entry.account_id || (accountIds.length === 1 ? accountIds[0] : undefined);
      if (!accountId || !accountIds.includes(accountId)) {
        throw new Error("Add this entry from a holding in the intended account.");
      }
      const oldSecurity = record(securities[entry.security_id ?? ""]);
      const symbol = entry.symbol.trim().toUpperCase();
      const securityId = entry.security_id && String(oldSecurity.symbol ?? "").toUpperCase() === symbol
        ? entry.security_id : `manual-security:${id}:${symbol}:${entry.currency || entry.iso_currency_code || "USD"}`;
      if (!securities[securityId]) securities[securityId] = {
        security_id: securityId, symbol, name: entry.name,
        currency: entry.currency || entry.iso_currency_code,
        instrument_kind: entry.instrument_kind, identifier_type: entry.identifier_type,
      };
      positions[id] = { ...entry, position_id: id, security_id: securityId, account_id: accountId };
    }
    return { ...financial, updated_at: updatedAt, financial_core_v7: {
      ...core, positions, securities, account_summary: portfolio.account_summary,
      total_value: portfolio.total_value, cash_balance: portfolio.cash_balance,
    } };
  }
  const sources = record(financial.sources);
  const statement = record(sources.statement);
  const selected = snapshotId || String(statement.active_snapshot_id ?? "");
  const snapshots = getStatementSnapshots(financial);
  if (selected && !snapshots.some(snapshot => snapshot.id === selected)) {
    throw new Error("This statement is no longer available. Reopen the portfolio before saving.");
  }
  const snapshot = snapshots.find(item => item.id === selected);
  const canonical = record(snapshot?.canonical_v2 ?? financial.portfolio ?? snapshot);
  const updated = { ...canonical, holdings: portfolio.holdings,
    account_summary: { ...record(canonical.account_summary),
      ending_value: portfolio.account_summary?.ending_value,
      equities_value: portfolio.account_summary?.equities_value,
      cash_balance: portfolio.account_summary?.cash_balance,
      change_in_value: portfolio.account_summary?.change_in_value },
    total_value: portfolio.total_value, cash_balance: portfolio.cash_balance };
  const updatedSnapshots = snapshots.map(value => {
      const snapshot = record(value);
      return selected && snapshot.id === selected ? { ...snapshot, canonical_v2: updated } : value;
  });
  const modern = Array.isArray(statement.snapshots) && statement.snapshots.length > 0;
  return { ...financial, portfolio: updated, updated_at: updatedAt,
    ...(modern ? { sources: { ...sources, statement: { ...statement, snapshots: updatedSnapshots } } }
      : snapshots.length ? { documents: { ...record(financial.documents), statements: updatedSnapshots } } : {}),
  };
}

import type { PortfolioData } from "@/components/kai/types/portfolio";
import type { FinanceSource } from "@/lib/finance-sharing/contract";
import {
  getActiveSource,
  getActiveStatementSnapshotId,
  getFinancialCoreV7Portfolio,
  getPlaidPortfolio,
  getStatementPortfolio,
  getStatementSnapshots,
} from "./financial-sources";
import { normalizeStatementPortfolio } from "./statement-portfolio";

/** Resolve the named source without falling through to the current selection. */
export function resolveFinancePortfolio(financial: Record<string, unknown>, source: FinanceSource): PortfolioData | null {
  if (source.representation === "current-v7") {
    if (getActiveSource(financial) !== source.kind) return null;
    if (source.kind === "plaid") return getPlaidPortfolio(financial);
    const snapshots = getStatementSnapshots(financial);
    // The V7 core has no statement ID linking its positions to one of
    // several artifact records. A legacy selection alone cannot bind them.
    if (snapshots.length > 1 || getActiveStatementSnapshotId(financial) !== source.snapshotId ||
        (source.snapshotId !== null && !snapshots.some(snapshot => snapshot.id === source.snapshotId))) return null;
    return getFinancialCoreV7Portfolio(financial);
  }
  if (source.kind === "plaid") return getPlaidPortfolio(financial);
  if (source.snapshotId) {
    const snapshot = getStatementSnapshots(financial).find(item => item.id === source.snapshotId);
    if (!snapshot) return null;
    if (snapshot.canonical_v2 && typeof snapshot.canonical_v2 === "object") {
      return normalizeStatementPortfolio(snapshot.canonical_v2 as Record<string, unknown>, snapshot);
    }
    // An artifact reference alone cannot stand in for an older statement.
    return Array.isArray(snapshot.holdings) ? normalizeStatementPortfolio(snapshot, snapshot) : null;
  }
  return getStatementSnapshots(financial).length ? null : getStatementPortfolio(financial);
}

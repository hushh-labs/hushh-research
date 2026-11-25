import { getSessionItem } from "@/lib/utils/session-storage";
import { vaultConnections } from "@/lib/kai/plaid-vault/vault-sync";
/** Read existing workflow state; Feed never authors or repairs it. */
export function getPendingImportReview(userId: string) {
  const raw = getSessionItem("kai_portfolio_import_background_v1");
  if (!raw || raw.length > 5_000_000) return null;
  try {
    const value = JSON.parse(raw);
    if (value.version !== 1 || value.userId !== userId || value.status !== "completed" ||
        typeof value.runId !== "string" || !value.runId || value.runId.length > 160 ||
        !value.parsedPortfolio || typeof value.parsedPortfolio !== "object") return null;
    return { runId: value.runId as string, timestamp: typeof value.updatedAt === "string" ? value.updatedAt : null };
  } catch { return null; }
}
export function confirmedVaultReconnects(financial: Record<string, unknown> | null) {
  return Object.entries(vaultConnections(financial)).filter(([, item]) => item.status === "needs_relink")
    .map(([itemId, item]) => ({ itemId, institute: item.institution_name, timestamp: null }));
}
export const existingImportReviewHref = () => "/one/kai/import?stage=reviewing&from=%2Fone%2Ffeed";

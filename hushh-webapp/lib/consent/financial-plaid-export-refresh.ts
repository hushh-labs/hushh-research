import {
  hasVaultConnections,
  refreshVaultConnections,
} from "@/lib/kai/plaid-vault/vault-sync";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

export class PlaidExportRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaidExportRefreshError";
  }
}

export function shouldRefreshPlaidForConsentScope(scope: string): boolean {
  const normalized = scope.trim();
  return (
    normalized === "attr.financial" ||
    normalized.startsWith("attr.financial.") ||
    normalized === "pkm.read"
  );
}

/**
 * Forces a fresh live Plaid sync into the encrypted financial PKM domain before
 * projecting shareable financial or full-vault exports.
 */
export async function ensureFreshPlaidProjectionForScope(params: {
  userId: string;
  scope: string;
  vaultKey: string;
  vaultOwnerToken: string;
  assertCurrent?: () => void;
}): Promise<void> {
  if (!shouldRefreshPlaidForConsentScope(params.scope)) {
    return;
  }
  const financialSnapshot = await PersonalKnowledgeModelService.getDomainSnapshot({
    userId: params.userId,
    domain: "financial",
    vaultOwnerToken: params.vaultOwnerToken,
    force: true,
  });
  params.assertCurrent?.();
  if (!financialSnapshot) {
    return;
  }
  const financialData = await PersonalKnowledgeModelService.decryptDomainSnapshot({
    snapshot: financialSnapshot,
    vaultKey: params.vaultKey,
  });
  params.assertCurrent?.();
  if (!hasVaultConnections(financialData)) {
    return;
  }
  const refreshOutcome = await refreshVaultConnections({
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    financial: financialData,
    force: true,
  });
  params.assertCurrent?.();
  if (
    refreshOutcome.refreshed === 0 &&
    (refreshOutcome.failed > 0 || refreshOutcome.needsRelink.length > 0)
  ) {
    throw new PlaidExportRefreshError(
      "Reconnect or refresh your linked bank in Connectors before sharing real-time financial information.",
    );
  }
}

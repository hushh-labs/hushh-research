import { useRef } from "react";
import { ScopeCommerceService, commerceReadinessCopy } from "@/lib/services/scope-commerce-service";
import { AuthService } from "@/lib/services/auth-service";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import type { PendingConsent } from "@/lib/consent/use-consent-actions";

export function isPkmScope(scope: string): boolean { return scope === "pkm.read" || scope.startsWith("attr."); }
export function usePaidApprovalState() {
  const paidApprovals = useRef(new Set<string>());
  const paidApprovalKeys = useRef(new Map<string, string>());
  return { paidApprovals, paidApprovalKeys };
}

/** Intercept before plaintext export; approved paid terms remain inactive. */
export async function approvePaidOwnerTerms(consent: PendingConsent, vaultOwnerToken: string,
  state: ReturnType<typeof usePaidApprovalState>, ownerError: (message: string) => Error): Promise<string | null> {
  const metadata = consent.metadata || {};
  if (!isPkmScope(consent.scope) || !(metadata.scope_handle || metadata.commercial_required)) return null;
  const epoch = snapshotVaultSessionEpoch();
  const requireCurrent = () => { if (!isVaultSessionEpochCurrent(epoch)) throw ownerError("Your vault session changed. Review this request again."); };
  const firebaseToken = await AuthService.getIdToken();
  requireCurrent();
  if (!firebaseToken) throw ownerError("Sign in again before reviewing this request.");
  const request = await ScopeCommerceService.scopeRequest(firebaseToken, consent.id);
  requireCurrent();
  if (request.role !== "owner") throw ownerError("Open this request in the information owner's account.");
  if (request.tariff && request.tariff.price_cents > 0) {
    const readiness = await ScopeCommerceService.readiness(firebaseToken);
    requireCurrent();
    if (!readiness.capabilities.approve_paid_request) throw ownerError(commerceReadinessCopy(readiness));
    const durationHours = consent.durationHours || request.duration_seconds / 3600;
    let key = state.paidApprovalKeys.current.get(consent.id);
    if (!key) { key = crypto.randomUUID(); state.paidApprovalKeys.current.set(consent.id, key); }
    await ScopeCommerceService.approveInactive(vaultOwnerToken, consent.id, durationHours * 3600, key);
    state.paidApprovals.current.add(consent.id);
    return "Terms approved. Waiting for buyer payment and encrypted preparation.";
  }
  if (metadata.commercial_required === true) throw ownerError("Refresh this paid request before continuing.");
  return null;
}

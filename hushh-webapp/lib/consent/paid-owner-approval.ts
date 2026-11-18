import { useRef } from "react";
import { ScopeCommerceService, commerceReadinessCopy, type NegativeNetAcknowledgement } from "@/lib/services/scope-commerce-service";
import { AuthService } from "@/lib/services/auth-service";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import type { PendingConsent } from "@/lib/consent/use-consent-actions";
import { CommerceActionError } from "@/lib/services/scope-commerce-readiness";
import { prepareAndStagePaidScopeExport } from "@/lib/consent/scope-commerce-export";

export function isPkmScope(scope: string): boolean { return scope === "pkm.read" || scope.startsWith("attr."); }
export function usePaidApprovalState() {
  const paidApprovals = useRef(new Set<string>());
  const paidApprovalKeys = useRef(new Map<string, string>());
  const paidPendingPayment = useRef(new Set<string>());
  return { paidApprovals, paidApprovalKeys, paidPendingPayment };
}

/**
 * Unified single-click paid approval: freeze owner terms and, when coins are
 * already reserved, encrypt and activate the export immediately in the same click.
 */
export async function approvePaidOwnerTerms(
  consent: PendingConsent,
  vaultOwnerToken: string,
  state: ReturnType<typeof usePaidApprovalState>,
  ownerError: (message: string) => Error,
  modelProcessingAllowed = false,
  options?: {
    userId?: string | null;
    vaultKey?: string | null;
    negativeNetAcknowledgement?: NegativeNetAcknowledgement;
  },
): Promise<string | null> {
  const metadata = consent.metadata || {};
  if (!isPkmScope(consent.scope) || !(metadata.scope_handle || metadata.commercial_required)) return null;
  const epoch = snapshotVaultSessionEpoch();
  const requireCurrent = () => { if (!isVaultSessionEpochCurrent(epoch)) throw ownerError("Your vault session changed. Review this request again."); };
  const firebaseToken = await AuthService.getIdToken();
  requireCurrent();
  if (!firebaseToken) throw ownerError("Sign in again before reviewing this request.");
  const request = await ScopeCommerceService.scopeRequest(firebaseToken, consent.id).catch(error => {
    if (error instanceof CommerceActionError && error.code &&
      ["scope_unavailable", "recipient_key_changed", "recipient_or_scope_unavailable"].includes(error.code)) {
      throw ownerError(error.message);
    }
    throw error;
  });
  requireCurrent();
  if (request.role !== "owner") throw ownerError("Open this request in the information owner's account.");
  const purchaseStatus = request.purchase?.status ?? "";
  const isPaid = Boolean((request.tariff && request.tariff.price_cents > 0) || request.purchase || metadata.commercial_required === true);
  if (request.tariff && request.tariff.price_cents > 0) {
    const readiness = await ScopeCommerceService.readiness(firebaseToken);
    requireCurrent();
    if (!readiness.capabilities.approve_paid_request) throw ownerError(commerceReadinessCopy(readiness));
    const durationHours = consent.durationHours || request.duration_seconds / 3600;
    let key = state.paidApprovalKeys.current.get(consent.id);
    if (!key) { key = crypto.randomUUID(); state.paidApprovalKeys.current.set(consent.id, key); }
    const approval = await ScopeCommerceService.approveInactive(vaultOwnerToken, consent.id, durationHours * 3600, key, modelProcessingAllowed);
    requireCurrent();
    state.paidApprovals.current.add(consent.id);

    const latest = approval.status === "approved_funded"
      ? await ScopeCommerceService.scopeRequest(firebaseToken, consent.id)
      : request;
    requireCurrent();
    const activePurchase = latest.purchase ?? request.purchase;
    if (activePurchase && (activePurchase.status === "reserved" || activePurchase.status === "preparing")) {
      const userId = options?.userId?.trim();
      const vaultKey = options?.vaultKey?.trim();
      if (!userId || !vaultKey) {
        throw ownerError("Unlock your vault to share this information.");
      }
      const negativeTerms = latest.negative_net_acknowledgement;
      if ((activePurchase.net_earnings_micro_usd ?? 0) < 0 && negativeTerms && (
        options?.negativeNetAcknowledgement?.binding !== negativeTerms.binding
        || options.negativeNetAcknowledgement.acknowledged !== true
      )) {
        throw ownerError("Review and confirm the fee notice before sharing this request.");
      }
      await prepareAndStagePaidScopeExport({
        purchaseId: activePurchase.id,
        userId,
        vaultKey,
        vaultOwnerToken,
        negativeNetAcknowledgement: options?.negativeNetAcknowledgement,
        activateOnStage: true,
      });
      state.paidPendingPayment?.current.delete(consent.id);
      return "Shared. Access is active now.";
    }
    if (activePurchase && (activePurchase.status === "staged" || activePurchase.status === "active" || activePurchase.status === "armed")) {
      state.paidPendingPayment?.current.delete(consent.id);
      return "Shared. Access is active now.";
    }
    state.paidPendingPayment?.current.add(consent.id);
    return "Approved. Waiting for payment before sharing.";
  }
  if (isPaid && (purchaseStatus === "reserved" || purchaseStatus === "preparing")) {
    const userId = options?.userId?.trim();
    const vaultKey = options?.vaultKey?.trim();
    if (!userId || !vaultKey) throw ownerError("Unlock your vault to share this information.");
    await prepareAndStagePaidScopeExport({
      purchaseId: request.purchase!.id,
      userId,
      vaultKey,
      vaultOwnerToken,
      negativeNetAcknowledgement: options?.negativeNetAcknowledgement,
      activateOnStage: true,
    });
    state.paidApprovals.current.add(consent.id);
    state.paidPendingPayment?.current.delete(consent.id);
    return "Shared. Access is active now.";
  }
  if (metadata.commercial_required === true) throw ownerError("Refresh this paid request before continuing.");
  return null;
}

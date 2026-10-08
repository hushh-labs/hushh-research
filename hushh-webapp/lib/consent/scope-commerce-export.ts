import { buildConsentExportForScope } from "@/lib/consent/export-builder";
import {
  buildConsentExportAadV2,
  buildConsentExportEnvelopeSubmissionV2,
  canonicalConsentExportAad,
  canonicalConsentExportJson,
} from "@/lib/consent/export-envelope-v2";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { ScopeCommerceService } from "@/lib/services/scope-commerce-service";
import type { NegativeNetAcknowledgement } from "@/lib/services/scope-commerce-service";
import {
  encryptForExport,
  generateExportKey,
  wrapExportKeyForConnector,
} from "@/lib/vault/export-encrypt";

/** Owner-device encryption. The server fixes identity and expiry before sealing. */
export async function prepareAndStagePaidScopeExport(params: {
  purchaseId: string;
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  negativeNetAcknowledgement?: NegativeNetAcknowledgement;
}) {
  const acknowledgement = params.negativeNetAcknowledgement
    ? { ...params.negativeNetAcknowledgement } : undefined;
  const ownerCosts = acknowledgement ? { negative_net_acknowledgement: acknowledgement } : {};
  const epoch = snapshotVaultSessionEpoch();
  const assertCurrent = () => {
    if (!isVaultSessionEpochCurrent(epoch)) throw new Error("Unlock your vault again before sharing.");
  };
  const context = await ScopeCommerceService.getPurchase(params.purchaseId, params.vaultOwnerToken);
  assertCurrent();
  const scope = String(context.machineScope || context.machine_scope || "");
  if (!scope.startsWith("attr.")) throw new Error("The approved scope is unavailable.");
  const built = await buildConsentExportForScope({
    userId: params.userId, scope, vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
  });
  if (!Number.isSafeInteger(built.sourceContentRevision) || !Number.isSafeInteger(built.sourceManifestRevision) ||
      Number(built.sourceContentRevision) < 1 || Number(built.sourceManifestRevision) < 1) {
    throw new Error("Refresh your saved information before preparing this export.");
  }
  const sourceRevisions = {
    contentRevision: Number(built.sourceContentRevision),
    manifestRevision: Number(built.sourceManifestRevision),
  };
  assertCurrent();
  const preparation = await ScopeCommerceService.preparePurchase(
    params.purchaseId, { sourceRevisions, ...ownerCosts }, params.vaultOwnerToken,
  );
  assertCurrent();
  if (preparation.machineScope !== scope || !preparation.preparationId || !preparation.exportId ||
      preparation.exportRevision !== 1 || !Number.isSafeInteger(preparation.startsAtMs) ||
      !Number.isSafeInteger(preparation.expiresAtMs) || preparation.startsAtMs <= Date.now() ||
      preparation.expiresAtMs <= preparation.startsAtMs) {
    throw new Error("The export preparation changed. Refresh before sharing.");
  }
  const aad = await buildConsentExportAadV2({
    appId: preparation.buyerAppId, grantId: preparation.grantId,
    exportId: preparation.exportId, revision: preparation.exportRevision,
    machineScope: preparation.machineScope, scopeHandle: preparation.scopeHandle,
    connectorPublicKey: preparation.connectorPublicKey, expiresAtMs: preparation.expiresAtMs,
  });
  if (aad.recipient_key_fingerprint !== preparation.recipientKeyFingerprint) {
    throw new Error("The recipient key changed. Request access again.");
  }
  const exportKey = await generateExportKey();
  const encrypted = await encryptForExport(JSON.stringify(built.payload), exportKey, {
    additionalData: canonicalConsentExportAad(aad),
  });
  const exportEnvelope = await buildConsentExportEnvelopeSubmissionV2({
    aad, ciphertextBase64: encrypted.ciphertext,
  });
  const wrapped = await wrapExportKeyForConnector({
    exportKeyHex: exportKey, connectorPublicKey: preparation.connectorPublicKey,
    connectorKeyId: preparation.connectorKeyId,
    additionalData: canonicalConsentExportJson(exportEnvelope),
  });
  assertCurrent();
  return ScopeCommerceService.stagePurchase(params.purchaseId, {
    ...ownerCosts,
    preparation_id: preparation.preparationId,
    envelope: {
      ...encrypted, exportEnvelope, sourceRevisions,
      wrappedKey: {
        wrapped_export_key: wrapped.wrappedExportKey,
        wrapped_key_iv: wrapped.wrappedKeyIv, wrapped_key_tag: wrapped.wrappedKeyTag,
        sender_public_key: wrapped.senderPublicKey, wrapping_alg: wrapped.wrappingAlg,
        connector_key_id: wrapped.connectorKeyId,
      },
    },
  }, params.vaultOwnerToken);
}

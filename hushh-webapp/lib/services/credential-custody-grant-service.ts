"use client";

import { ApiService } from "@/lib/services/api-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import type { AiSelectionRecipient } from "@/lib/one/ai-selection-seal";
import { CREDENTIAL_ID, CredentialError, type CredentialRecord } from "@/lib/pkm/credentials-contracts";
import { buildConsentExportAadV2, buildConsentExportEnvelopeSubmissionV2, canonicalConsentExportAad, canonicalConsentExportJson } from "@/lib/consent/export-envelope-v2";
import { encryptForExport, generateExportKey, wrapExportKeyForConnector } from "@/lib/vault/export-encrypt";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";

export type BrowserCredentialExportSelection = {
  owner_id: string; pod_id: string; pod_key_id: string;
  field: { domain: "credentials"; path: string; export_revision: number;
    source_content_revision: number; source_manifest_revision: number; grant_ref: string };
};

/** A current, exact record-envelope projection for the same owner's pod.
 * This does not unwrap the password or give an arbitrary recipient its key. */
export async function buildCredentialCustodyExport(params: {
  userId: string; vaultKey: string; vaultOwnerToken: string; scope: string;
}): Promise<{ payload: Record<string, unknown>; sourceContentRevision: number; sourceManifestRevision: number }> {
  const match = /^attr\.credentials\.(summary|secrets)\.(cred_[a-f0-9]{32})$/.exec(params.scope);
  if (!match) throw new CredentialError("CREDENTIAL_GRANT_INVALID");
  const branch = match[1]!;
  const id = match[2]!;
  const epoch = snapshotVaultSessionEpoch();
  const owner = snapshotValidatedAuthSessionOwner();
  const loaded = await PersonalKnowledgeModelService.loadDomainSnapshot({ ...params, domain: "credentials", force: true });
  if (owner?.userId !== params.userId || !isValidatedAuthSessionOwnerCurrent(owner) || !isVaultSessionEpochCurrent(epoch)) {
    throw new CredentialError("CREDENTIAL_OWNER_RETIRED");
  }
  const items = loaded.data?.[branch];
  const item = items && typeof items === "object" ? (items as Record<string, unknown>)[id] : null;
  const tombstones = loaded.data?.tombstones;
  if (!loaded.snapshot || !item || tombstones && typeof tombstones === "object" && (tombstones as Record<string, unknown>)[id]) {
    throw new CredentialError("CREDENTIAL_UNAVAILABLE");
  }
  return { payload: { credentials: { [branch]: { [id]: item } },
    __export_metadata: { scope: params.scope, source_domain: "credentials", approved_paths: [`${branch}.${id}`], manifest_version: loaded.snapshot.manifestRevision } },
    sourceContentRevision: loaded.snapshot.contentRevision, sourceManifestRevision: loaded.snapshot.manifestRevision };
}

/** Explicit save/use approval seals one canonical encrypted record through the
 * existing Consent Protocol. A vault-only record remains opaque to the pod:
 * its envelope has no pod key wrap; transient fill has separate authority. */
export async function admitCredentialCustodyExport(params: {
  context: { userId: string; vaultKey: string; vaultOwnerToken: string; beforeEffect?: () => Promise<void>; custodyGrantDurationHours?: number };
  credentialId: string;
  sourceContentRevision: number;
  sourceManifestRevision: number;
  recipient: AiSelectionRecipient;
}): Promise<BrowserCredentialExportSelection> {
  const { context, credentialId, recipient } = params;
  const epoch = snapshotVaultSessionEpoch();
  const owner = snapshotValidatedAuthSessionOwner();
  const current = () => owner?.userId === context.userId && isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(epoch);
  const guard = async () => {
    if (!current()) throw new CredentialError("CREDENTIAL_OWNER_RETIRED");
    await context.beforeEffect?.();
    if (!current()) throw new CredentialError("CREDENTIAL_OWNER_RETIRED");
  };
  await guard();
  const durationHours = context.custodyGrantDurationHours ?? 24;
  if (!CREDENTIAL_ID.test(credentialId) || !Number.isSafeInteger(durationHours) || durationHours < 1 || durationHours > 8760) {
    throw new CredentialError("CREDENTIAL_GRANT_INVALID");
  }
  const loaded = await PersonalKnowledgeModelService.loadDomainSnapshot({ ...context, domain: "credentials", force: true });
  await guard();
  if (!loaded.snapshot || loaded.snapshot.contentRevision !== params.sourceContentRevision ||
      loaded.snapshot.manifestRevision !== params.sourceManifestRevision) throw new CredentialError("CREDENTIAL_REVISION_STALE");
  const records = loaded.data?.secrets;
  const record = records && typeof records === "object" ? (records as Record<string, CredentialRecord>)[credentialId] : null;
  if (!record || record.schemaVersion !== 1 || record.aad.ownerId !== context.userId || record.aad.credentialId !== credentialId) {
    throw new CredentialError("CREDENTIAL_UNAVAILABLE");
  }
  const scope = `attr.credentials.secrets.${credentialId}`;
  const path = `secrets.${credentialId}`;
  const operationId = crypto.randomUUID().replaceAll("-", "");
  const response = await ApiService.apiFetch("/api/consent/owner-items/requests", {
    method: "POST", cache: "no-store", headers: { Authorization: `Bearer ${context.vaultOwnerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operation_id: operationId, credential_id: credentialId, branch: "secrets", pod_id: recipient.hushhId,
      pod_key_id: recipient.podKeyId, source_content_revision: params.sourceContentRevision,
      source_manifest_revision: params.sourceManifestRevision, duration_hours: durationHours }),
    beforeDispatch: guard, isEffectCurrent: current,
  });
  await guard();
  if (!response.ok) throw new CredentialError("CREDENTIAL_GRANT_UNAVAILABLE");
  const preparation = await response.json() as { request_id: string; scope: string; scope_handle: string;
    recipient_key_fingerprint: string; duration_hours: number; selection: BrowserCredentialExportSelection };
  if (preparation.scope !== scope || preparation.duration_hours !== durationHours || !preparation.request_id || !preparation.scope_handle ||
      preparation.selection.owner_id !== context.userId || preparation.selection.pod_id !== recipient.hushhId ||
      preparation.selection.pod_key_id !== recipient.podKeyId || preparation.selection.field.grant_ref !== preparation.request_id ||
      preparation.selection.field.domain !== "credentials" || preparation.selection.field.path !== path || preparation.selection.field.export_revision !== 1 ||
      preparation.selection.field.source_content_revision !== params.sourceContentRevision ||
      preparation.selection.field.source_manifest_revision !== params.sourceManifestRevision) throw new CredentialError("CREDENTIAL_GRANT_INVALID");
  const aad = await buildConsentExportAadV2({ appId: "agent_one", grantId: preparation.request_id,
    machineScope: scope, scopeHandle: preparation.scope_handle, connectorPublicKey: recipient.publicKey,
    expiresAtMs: Date.now() + durationHours * 3600_000 });
  if (aad.recipient_key_fingerprint !== preparation.recipient_key_fingerprint) throw new CredentialError("CREDENTIAL_RECIPIENT_CHANGED");
  const key = await generateExportKey();
  const encrypted = await encryptForExport(JSON.stringify({ credentials: { secrets: { [credentialId]: record } },
    __export_metadata: { scope, source_domain: "credentials", approved_paths: [path], manifest_version: params.sourceManifestRevision } }),
  key, { additionalData: canonicalConsentExportAad(aad) });
  const exportEnvelope = await buildConsentExportEnvelopeSubmissionV2({ aad, ciphertextBase64: encrypted.ciphertext });
  const wrapped = await wrapExportKeyForConnector({ exportKeyHex: key, connectorPublicKey: recipient.publicKey,
    connectorKeyId: recipient.podKeyId, additionalData: canonicalConsentExportJson(exportEnvelope) });
  await guard();
  const fresh = await PersonalKnowledgeModelService.getDomainSnapshot({ userId: context.userId, domain: "credentials", vaultOwnerToken: context.vaultOwnerToken, force: true });
  await guard();
  if (!fresh || fresh.contentRevision !== params.sourceContentRevision || fresh.manifestRevision !== params.sourceManifestRevision) {
    throw new CredentialError("CREDENTIAL_REVISION_STALE");
  }
  const approved = await ApiService.approvePendingConsent({ userId: context.userId, vaultOwnerToken: context.vaultOwnerToken,
    requestId: preparation.request_id, encryptedData: encrypted.ciphertext, encryptedIv: encrypted.iv, encryptedTag: encrypted.tag,
    ...wrapped, sourceContentRevision: params.sourceContentRevision, sourceManifestRevision: params.sourceManifestRevision,
    durationHours, exportEnvelope, modelProcessingAllowed: false, beforeEffect: guard, isEffectCurrent: current });
  await guard();
  if (!approved.ok) throw new CredentialError("CREDENTIAL_GRANT_UNAVAILABLE");
  return preparation.selection;
}

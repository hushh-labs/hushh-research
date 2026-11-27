"use client";

import { ApiService } from "@/lib/services/api-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { WEBSITE_SECRET_ID, WebsiteCredentialError, parseWebsiteCredentialItem } from "@/lib/pkm/website-credential";
import { buildConsentExportAadV2, buildConsentExportEnvelopeSubmissionV2, canonicalConsentExportAad, canonicalConsentExportJson } from "@/lib/consent/export-envelope-v2";
import { encryptForExport, generateExportKey, wrapExportKeyForConnector } from "@/lib/vault/export-encrypt";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

export type CredentialShareContext = { userId: string; vaultKey: string; vaultOwnerToken: string; beforeEffect?: () => Promise<void> };
export type CredentialShareReview = {
  request_id: string; scope: string; scope_handle: string; recipient_key_fingerprint: string; duration_hours: number;
  recipient: { app_id: string; agent_id: string; key_id: string; public_key: string; fingerprint: string; label: string };
  credentialId: string; branch: "items"; contentRevision: number; manifestRevision: number;
};

function session(context: CredentialShareContext) {
  const owner = snapshotValidatedAuthSessionOwner();
  const epoch = snapshotVaultSessionEpoch();
  const current = () => owner?.userId === context.userId && isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(epoch);
  const check = async () => {
    if (!current()) throw new WebsiteCredentialError("CREDENTIAL_OWNER_RETIRED");
    await context.beforeEffect?.();
    if (!current()) throw new WebsiteCredentialError("CREDENTIAL_OWNER_RETIRED");
  };
  return { current, check };
}

/** Creates a pending request only. The owner reviews the server-resolved app
 * and exact scope before approveCredentialShare sends an encrypted export. */
export async function prepareCredentialShare(context: CredentialShareContext, input: {
  credentialId: string; appId: string; branch: "items"; durationHours: number;
}): Promise<CredentialShareReview> {
  const owner = session(context);
  await owner.check();
  if (!WEBSITE_SECRET_ID.test(input.credentialId) || !input.appId.trim() || input.appId.length > 128 ||
      !["items"].includes(input.branch) || !Number.isSafeInteger(input.durationHours) || input.durationHours < 1 || input.durationHours > 8760) {
    throw new WebsiteCredentialError("CREDENTIAL_GRANT_INVALID");
  }
  const loaded = await PersonalKnowledgeModelService.loadDomainSnapshot({ ...context, domain: "secrets", force: true });
  const snapshot = loaded.snapshot;
  await owner.check();
  const items = loaded.data?.items;
  const item = items && typeof items === "object" ? (items as Record<string, unknown>)[input.credentialId] : null;
  if (!snapshot || !parseWebsiteCredentialItem(input.credentialId, item)) throw new WebsiteCredentialError("CREDENTIAL_UNAVAILABLE");
  const response = await ApiService.apiFetch("/api/consent/owner-items/requests", { method: "POST", cache: "no-store",
    headers: { Authorization: `Bearer ${context.vaultOwnerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operation_id: crypto.randomUUID().replaceAll("-", ""), secret_id: input.credentialId,
      branch: input.branch, recipient_kind: "registered_app", recipient_app_id: input.appId.trim(),
      source_content_revision: snapshot.contentRevision, source_manifest_revision: snapshot.manifestRevision, duration_hours: input.durationHours }),
    beforeDispatch: owner.check, isEffectCurrent: owner.current });
  await owner.check();
  if (!response.ok) throw new WebsiteCredentialError("CREDENTIAL_GRANT_UNAVAILABLE");
  const review = await response.json() as CredentialShareReview;
  if (review.scope !== `attr.secrets.${input.branch}.${input.credentialId}` || review.duration_hours !== input.durationHours ||
      review.recipient.app_id !== input.appId.trim() || !review.request_id || !review.scope_handle || !review.recipient.key_id ||
      review.recipient_key_fingerprint !== review.recipient.fingerprint) throw new WebsiteCredentialError("CREDENTIAL_GRANT_INVALID");
  return { ...review, credentialId: input.credentialId, branch: input.branch, contentRevision: snapshot.contentRevision, manifestRevision: snapshot.manifestRevision };
}

export async function approveCredentialShare(context: CredentialShareContext, review: CredentialShareReview): Promise<string> {
  const owner = session(context);
  await owner.check();
  if (review.scope !== `attr.secrets.${review.branch}.${review.credentialId}` || !WEBSITE_SECRET_ID.test(review.credentialId)) {
    throw new WebsiteCredentialError("CREDENTIAL_GRANT_INVALID");
  }
  const loaded = await PersonalKnowledgeModelService.loadDomainSnapshot({ ...context, domain: "secrets", force: true });
  await owner.check();
  if (!loaded.snapshot || loaded.snapshot.contentRevision !== review.contentRevision || loaded.snapshot.manifestRevision !== review.manifestRevision) {
    throw new WebsiteCredentialError("CREDENTIAL_REVISION_STALE");
  }
  const branch = loaded.data?.[review.branch];
  let value: unknown = branch && typeof branch === "object" ? (branch as Record<string, unknown>)[review.credentialId] : null;
  if (!value) throw new WebsiteCredentialError("CREDENTIAL_UNAVAILABLE");
  if (!parseWebsiteCredentialItem(review.credentialId, value)) throw new WebsiteCredentialError("CREDENTIAL_UNAVAILABLE");
  const aad = await buildConsentExportAadV2({ appId: review.recipient.app_id, grantId: review.request_id, machineScope: review.scope,
    scopeHandle: review.scope_handle, connectorPublicKey: review.recipient.public_key, expiresAtMs: Date.now() + review.duration_hours * 3600_000 });
  if (aad.recipient_key_fingerprint !== review.recipient_key_fingerprint) throw new WebsiteCredentialError("CREDENTIAL_RECIPIENT_CHANGED");
  const key = await generateExportKey();
  const encrypted = await encryptForExport(JSON.stringify({ secrets: { [review.branch]: { [review.credentialId]: value } },
    __export_metadata: { scope: review.scope, source_domain: "secrets", approved_paths: [`${review.branch}.${review.credentialId}`], manifest_version: review.manifestRevision } }),
  key, { additionalData: canonicalConsentExportAad(aad) });
  value = null;
  const exportEnvelope = await buildConsentExportEnvelopeSubmissionV2({ aad, ciphertextBase64: encrypted.ciphertext });
  const wrapped = await wrapExportKeyForConnector({ exportKeyHex: key, connectorPublicKey: review.recipient.public_key,
    connectorKeyId: review.recipient.key_id, additionalData: canonicalConsentExportJson(exportEnvelope) });
  await owner.check();
  const response = await ApiService.approvePendingConsent({ userId: context.userId, vaultOwnerToken: context.vaultOwnerToken,
    requestId: review.request_id, encryptedData: encrypted.ciphertext, encryptedIv: encrypted.iv, encryptedTag: encrypted.tag,
    ...wrapped, sourceContentRevision: review.contentRevision, sourceManifestRevision: review.manifestRevision,
    durationHours: review.duration_hours, modelProcessingAllowed: false, exportEnvelope, beforeEffect: owner.check, isEffectCurrent: owner.current });
  await owner.check();
  if (!response.ok) throw new WebsiteCredentialError("CREDENTIAL_GRANT_UNAVAILABLE");
  return review.request_id;
}

export async function cancelCredentialShare(context: CredentialShareContext, review: CredentialShareReview): Promise<void> {
  const owner = session(context);
  await owner.check();
  const response = await ApiService.apiFetch("/api/consent/cancel", { method: "POST",
    headers: { Authorization: `Bearer ${context.vaultOwnerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ userId: context.userId, requestId: review.request_id }), beforeDispatch: owner.check, isEffectCurrent: owner.current });
  await owner.check();
  if (!response.ok) throw new WebsiteCredentialError("CREDENTIAL_GRANT_UNAVAILABLE");
}

/** Rebuild only the explicit owner-started item export while the owner is unlocked. */
export async function buildSecretItemExport(params: { userId: string; vaultKey: string; vaultOwnerToken: string; scope: string }) {
  const match = /^attr\.secrets\.items\.(sec_[a-f0-9]{16})$/.exec(params.scope);
  if (!match) throw new WebsiteCredentialError("CREDENTIAL_GRANT_INVALID");
  const owner = session(params); await owner.check();
  const loaded = await PersonalKnowledgeModelService.loadDomainSnapshot({ ...params, domain: "secrets", force: true });
  await owner.check();
  const items = loaded.data?.items;
  const item = items && typeof items === "object" ? (items as Record<string, unknown>)[match[1]!] : null;
  if (!loaded.snapshot || !item || typeof item !== "object" || Array.isArray(item)) throw new WebsiteCredentialError("CREDENTIAL_UNAVAILABLE");
  return { payload: { secrets: { items: { [match[1]!]: item } }, __export_metadata: { scope: params.scope,
    source_domain: "secrets", approved_paths: [`items.${match[1]}`], manifest_version: loaded.snapshot.manifestRevision } },
    sourceContentRevision: loaded.snapshot.contentRevision, sourceManifestRevision: loaded.snapshot.manifestRevision };
}

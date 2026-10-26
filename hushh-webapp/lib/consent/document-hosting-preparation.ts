import { connectorKeyFingerprint } from "@/lib/consent/export-envelope-v2";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import { DocumentHostingService, requireDocumentSession, type DocumentSession, type HostedTermsProjection, type HostedPreparationProjection, type PrivateDocumentManifest, type DocumentKeyChallenge } from "@/lib/services/document-hosting-service";
import { DriveDeviceSourceService } from "@/lib/services/drive-device-source-service";
import { canonicalDocumentJson, documentHash, encryptDocumentArtifact, documentContentCommitment, documentPackageDigest, documentPackageDigestFromWrapDigests, protectDocumentOwnerKey, recoverDocumentOwnerKey, unwrapDocumentKey, wrapDocumentKey, type DocumentDescriptor, type DocumentTerms, type DocumentWrap } from "./document-hosting-crypto";
import { prepareHostedPdf } from "./document-hosting-pdf";

export type HostedPreparationProgress = { stage: "source" | "preview" | "encrypt" | "upload" | "staged"; completed: number; total: number };
/** Requires an already committed, explicit preparation approval. Never infers copy consent from Drive. */
export async function prepareHostedDocuments(input: { session: DocumentSession; requestId: string; termsProjection: HostedPreparationProjection; signal: AbortSignal; onProgress?: (progress: HostedPreparationProgress) => void }): Promise<HostedTermsProjection> {
  const { session, requestId, signal } = input;
  const projection = input.termsProjection;
  requireDocumentSession(session, signal);
  if (projection.requestId !== requestId || projection.status !== "preparing_on_owner_device" || projection.ownerUserId !== session.userId ||
      !projection.files.length || projection.files.length > 25 || projection.amountCents === null || !projection.generationId) throw new Error("document_preparation_not_authorized");
  const credential = await DocumentHostingService.sourceSession(session, requestId, projection.revision, signal);
  const keys = new Map<string, string>(); const descriptors: DocumentDescriptor[] = [];
  const manifest: PrivateDocumentManifest = { version: 1, files: [] };
  let totalBytes = 0;
  try {
    if (credential.requestId !== requestId || credential.revision !== projection.revision || credential.sourceSelectionDigest !== projection.sourceSelectionDigest ||
        !Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now()) throw new Error("document_preparation_changed");
    const preparationDigest = await documentHash({ version: 1, requestId, ownerUserId: projection.ownerUserId,
      recipientUserId: projection.recipientUserId, generationId: projection.generationId, sourceSelectionDigest: credential.sourceSelectionDigest });
    if (projection.preparationDigest && projection.preparationDigest !== preparationDigest) throw new Error("document_preparation_changed");
    const sealAndUpload = async (bytes: Uint8Array, fileRef: string | null, role: DocumentDescriptor["role"]) => {
      requireDocumentSession(session, signal);
      input.onProgress?.({ stage: "encrypt", completed: descriptors.length, total: projection.files.length * 2 + 1 });
      const sealed = await encryptDocumentArtifact({ bytes, fileRef, role, artifactId: crypto.randomUUID(), preparationDigest });
      try {
        totalBytes += sealed.ciphertext.length;
        if (totalBytes > 32 * 1024 * 1024) throw new Error("document_package_size_limit");
        requireDocumentSession(session, signal);
        input.onProgress?.({ stage: "upload", completed: descriptors.length, total: projection.files.length * 2 + 1 });
        await DocumentHostingService.upload(session, requestId, projection.revision, sealed.descriptor, sealed.ciphertext, signal);
        descriptors.push(sealed.descriptor); keys.set(sealed.descriptor.artifactId, sealed.keyHex);
        return sealed.descriptor.artifactId;
      } finally { sealed.ciphertext.fill(0); }
    };
    for (const [index, file] of projection.files.entries()) {
      input.onProgress?.({ stage: "source", completed: index, total: projection.files.length });
      const original = await DriveDeviceSourceService.pdf(file, credential, signal, session.isCurrent);
      let derivative: Uint8Array | null = null;
      try {
        const mark = `One copy ${file.fileRef.slice(0, 8)} | recipient ${projection.recipientUserId.slice(0, 4)}*** | ${projection.accessExpiresAt.slice(0, 10)}`;
        const pdf = await prepareHostedPdf(original, mark, signal, (completed, total) => input.onProgress?.({ stage: "preview", completed, total }));
        derivative = pdf.watermarked;
        requireDocumentSession(session, signal);
        const originalArtifactId = await sealAndUpload(original, file.fileRef, "original");
        const watermarkedArtifactId = await sealAndUpload(derivative, file.fileRef, "watermarked");
        manifest.files.push({ fileRef: file.fileRef, name: file.name, mimeType: "application/pdf", sourceRevision: file.sourceRevision,
          sourceSha256: pdf.originalHash, originalArtifactId, watermarkedArtifactId, watermarkedSha256: await documentHash(derivative) });
      } finally { original.fill(0); derivative?.fill(0); }
    }
    const metadata = new TextEncoder().encode(canonicalDocumentJson(manifest));
    try { await sealAndUpload(metadata, null, "manifest"); } finally { metadata.fill(0); }
    const contentCommitment = await documentContentCommitment(preparationDigest, descriptors);
    const recipient = await DocumentHostingService.recipientKey(session, requestId, signal);
    const fingerprint = (await connectorKeyFingerprint(recipient.connectorPublicKey)).replace(/^sha256:/, "");
    if (recipient.publicKeyFingerprint !== fingerprint || recipient.connectorWrappingAlg !== "X25519-AES256-GCM") throw new Error("document_recipient_key_changed");
    const terms: DocumentTerms = { version: 1, revision: projection.revision, requestId, ownerUserId: projection.ownerUserId,
      recipientUserId: projection.recipientUserId, receiveThrough: projection.receiveThrough, contentCommitment,
      amountCents: projection.amountCents, currency: "usd", accessExpiresAt: projection.accessExpiresAt,
      rights: { preview: true, download: true }, activityDisclosureVersion: "one-document-activity-v1", copyDisclosureVersion: "one-document-copy-v1",
      recipientKeyId: recipient.connectorKeyId, recipientKeyFingerprint: fingerprint };
    const termsDigest = await documentHash(terms); const wraps: DocumentWrap[] = [];
    for (const [artifactId, keyHex] of keys) {
      requireDocumentSession(session, signal);
      wraps.push(await wrapDocumentKey({ artifactId, keyHex, contentCommitment, termsDigest, terms, publicKey: recipient.connectorPublicKey }));
      wraps.push({ artifactId, role: "owner_recovery", bundle: await protectDocumentOwnerKey(keyHex, session.vaultKey, canonicalDocumentJson({ version: 1,
        purpose: "one-document-owner-recovery", preparationDigest, artifactId, ownerUserId: session.userId })) });
    }
    const packageDigest = await documentPackageDigest(contentCommitment, termsDigest, wraps);
    const result = await DocumentHostingService.stagePackage(session, requestId, { expectedRevision: projection.revision, idempotencyKey: crypto.randomUUID(),
      generationId: projection.generationId, preparationDigest, contentCommitment, artifacts: descriptors, terms, termsDigest, wraps, packageDigest }, signal);
    input.onProgress?.({ stage: "staged", completed: projection.files.length, total: projection.files.length });
    return result;
  } finally { credential.accessToken = ""; keys.clear(); }
}

export async function verifyHostedRecipientKey(session: DocumentSession, requestId: string, keyId: string, signal: AbortSignal, purpose: "delivery" | "recovery" = "delivery"): Promise<void> {
  const connector = await OneKycClientZkService.readStoredConnector({ userId: session.userId, vaultKey: session.vaultKey, vaultOwnerToken: session.vaultOwnerToken, keyId });
  requireDocumentSession(session, signal);
  if (!connector || connector.connector_key_id !== keyId) throw new Error("document_key_unavailable");
  const recipientKeyFingerprint = (await connectorKeyFingerprint(connector.connector_public_key)).replace(/^sha256:/, "");
  const challenge = await DocumentHostingService.challenge<DocumentKeyChallenge>(session, requestId, { phase: "issue", purpose, recipientKeyId: keyId, recipientKeyFingerprint }, signal);
  const plaintext = await unwrapDocumentKey(challenge.bundle, connector, "");
  requireDocumentSession(session, signal);
  await DocumentHostingService.challenge(session, requestId, { phase: "verify", challengeId: challenge.challengeId, plaintext }, signal);
}

/** Explicit A-device recovery: rewrap unchanged ciphertext, preserve original payment provenance. */
export async function repairHostedRecipientKey(session: DocumentSession, requestId: string, projection: HostedTermsProjection, signal: AbortSignal): Promise<HostedTermsProjection> {
  requireDocumentSession(session, signal);
  const previous = await DocumentHostingService.ownerPackage(session, requestId, signal);
  if (projection.requestId !== requestId || projection.ownerUserId !== session.userId ||
      previous.terms.requestId !== requestId || previous.terms.ownerUserId !== session.userId || previous.terms.recipientUserId !== projection.recipientUserId ||
      previous.accessExpiresAt !== previous.terms.accessExpiresAt || previous.accessExpiresAt !== projection.accessExpiresAt ||
      !Number.isFinite(Date.parse(previous.accessExpiresAt)) || Date.parse(previous.accessExpiresAt) <= Date.now() ||
      previous.terms.contentCommitment !== previous.contentCommitment || previous.contentCommitment !== projection.contentCommitment ||
      previous.termsDigest !== projection.termsDigest || previous.packageDigest !== projection.packageDigest ||
      !/^[a-f0-9]{64}$/.test(previous.originalTermsDigest) || !/^[a-f0-9]{64}$/.test(previous.originalPackageDigest) ||
      await documentHash(previous.terms) !== previous.termsDigest ||
      await documentContentCommitment(previous.preparationDigest, previous.artifacts) !== previous.contentCommitment ||
      await documentPackageDigestFromWrapDigests(previous.contentCommitment, previous.termsDigest, previous.wrapDigests) !== previous.packageDigest)
    throw new Error("document_package_invalid");
  const artifactIds = new Set(previous.artifacts.map(item => item.artifactId));
  if (!artifactIds.size || artifactIds.size > 51 || artifactIds.size !== previous.artifacts.length ||
      previous.wraps.length !== artifactIds.size || previous.wrapDigests.length !== artifactIds.size * 2 ||
      new Set(previous.wrapDigests.map(item => `${item.artifactId}:${item.role}`)).size !== previous.wrapDigests.length ||
      new Set(previous.wraps.map(item => item.artifactId)).size !== previous.wraps.length ||
      previous.wrapDigests.some(item => !artifactIds.has(item.artifactId) || !["owner_recovery", "recipient"].includes(item.role) || !/^[a-f0-9]{64}$/.test(item.sha256)))
    throw new Error("document_package_invalid");
  for (const wrap of previous.wraps) {
    if (wrap.role !== "owner_recovery" || !artifactIds.has(wrap.artifactId) ||
        previous.wrapDigests.find(item => item.artifactId === wrap.artifactId && item.role === wrap.role)?.sha256 !== await documentHash(wrap))
      throw new Error("document_package_invalid");
  }
  requireDocumentSession(session, signal);
  const next = await DocumentHostingService.recoveryRecipientKey(session, requestId, signal);
  const fingerprint = (await connectorKeyFingerprint(next.connectorPublicKey)).replace(/^sha256:/, "");
  if (fingerprint !== next.publicKeyFingerprint || next.connectorWrappingAlg !== "X25519-AES256-GCM") throw new Error("document_recipient_key_changed");
  const terms: DocumentTerms = { ...previous.terms, revision: projection.revision + 1, recipientKeyId: next.connectorKeyId, recipientKeyFingerprint: fingerprint };
  const termsDigest = await documentHash(terms);
  const wraps: DocumentWrap[] = previous.wraps.filter(item => item.role === "owner_recovery");
  for (const artifact of previous.artifacts) {
    const recovery = previous.wraps.find(item => item.role === "owner_recovery" && item.artifactId === artifact.artifactId);
    if (!recovery || recovery.role !== "owner_recovery") throw new Error("document_key_unavailable");
    const keyHex = await recoverDocumentOwnerKey(recovery.bundle, session.vaultKey, canonicalDocumentJson({ version: 1, purpose: "one-document-owner-recovery",
      preparationDigest: previous.preparationDigest, artifactId: artifact.artifactId, ownerUserId: session.userId }));
    requireDocumentSession(session, signal);
    wraps.push(await wrapDocumentKey({ keyHex, artifactId: artifact.artifactId, contentCommitment: previous.contentCommitment, termsDigest, terms, publicKey: next.connectorPublicKey }));
  }
  const packageDigest = await documentPackageDigest(previous.contentCommitment, termsDigest, wraps);
  return DocumentHostingService.recoveryAmendment(session, requestId, { expectedRevision: projection.revision, idempotencyKey: crypto.randomUUID(),
    originalTermsDigest: previous.originalTermsDigest, originalPackageDigest: previous.originalPackageDigest,
    terms, termsDigest, wraps, packageDigest, recoveryAccepted: true }, signal);
}

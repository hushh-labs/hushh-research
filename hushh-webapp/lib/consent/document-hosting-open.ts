import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import { DocumentHostingService, requireDocumentSession, type DocumentSession, type HostedPackage, type PrivateDocumentManifest } from "@/lib/services/document-hosting-service";
import { connectorKeyFingerprint } from "@/lib/consent/export-envelope-v2";
import { canonicalDocumentJson, decryptDocumentArtifact, documentContentCommitment, documentPackageDigestFromWrapDigests, documentHash, documentWrapAad, unwrapDocumentKey, type DocumentDescriptor } from "./document-hosting-crypto";

export async function verifyHostedPackage(session: DocumentSession, value: HostedPackage): Promise<void> {
  if (value.terms.recipientUserId !== session.userId || !Number.isFinite(Date.parse(value.accessExpiresAt)) || Date.parse(value.accessExpiresAt) <= Date.now() ||
      value.terms.contentCommitment !== value.contentCommitment || value.terms.accessExpiresAt !== value.accessExpiresAt ||
      await documentHash(value.terms) !== value.termsDigest ||
      await documentContentCommitment(value.preparationDigest, value.artifacts) !== value.contentCommitment ||
      await documentPackageDigestFromWrapDigests(value.contentCommitment, value.termsDigest, value.wrapDigests) !== value.packageDigest)
    throw new Error("document_package_invalid");
  if (new Set(value.artifacts.map(item => item.artifactId)).size !== value.artifacts.length || value.artifacts.length > 51 ||
      new Set(value.wraps.map(item => `${item.artifactId}:${item.role}`)).size !== value.wraps.length ||
      new Set(value.wrapDigests.map(item => `${item.artifactId}:${item.role}`)).size !== value.wrapDigests.length)
    throw new Error("document_package_invalid");
  for (const wrap of value.wraps) {
    if (wrap.role !== "recipient" || wrap.recipientKeyId !== value.terms.recipientKeyId || wrap.recipientKeyFingerprint !== value.terms.recipientKeyFingerprint ||
        !value.wrapDigests.some(item => item.artifactId === wrap.artifactId && item.role === wrap.role && item.sha256) ||
        value.wrapDigests.find(item => item.artifactId === wrap.artifactId && item.role === wrap.role)?.sha256 !== await documentHash(wrap))
      throw new Error("document_package_invalid");
  }
}
export async function openHostedArtifact(session: DocumentSession, requestId: string, value: HostedPackage, descriptor: DocumentDescriptor, signal: AbortSignal): Promise<Uint8Array> {
  requireDocumentSession(session, signal);
  await verifyHostedPackage(session, value);
  if (value.terms.requestId !== requestId || !value.artifacts.some(item => canonicalDocumentJson(item) === canonicalDocumentJson(descriptor))) throw new Error("document_package_invalid");
  const wrap = value.wraps.find(item => item.artifactId === descriptor.artifactId && item.role === "recipient");
  if (!wrap || wrap.role !== "recipient") throw new Error("document_file_not_delivered");
  const connector = await OneKycClientZkService.readStoredConnector({ userId: session.userId, vaultKey: session.vaultKey,
    vaultOwnerToken: session.vaultOwnerToken, keyId: wrap.recipientKeyId });
  requireDocumentSession(session, signal);
  if (!connector || (await connectorKeyFingerprint(connector.connector_public_key)).replace(/^sha256:/, "") !== value.terms.recipientKeyFingerprint) throw new Error("document_key_unavailable");
  const key = await unwrapDocumentKey(wrap.bundle, connector, documentWrapAad(value.contentCommitment, value.termsDigest, descriptor.artifactId, value.terms));
  requireDocumentSession(session, signal);
  const ciphertext = await DocumentHostingService.artifact(session, requestId, descriptor.artifactId, signal);
  try {
    const bytes = await decryptDocumentArtifact(ciphertext, descriptor, value.preparationDigest, key);
    try { requireDocumentSession(session, signal); return bytes; } catch (cause) { bytes.fill(0); throw cause; }
  } finally { ciphertext.fill(0); }
}
export async function openHostedDocuments(session: DocumentSession, requestId: string, signal: AbortSignal): Promise<{ package: HostedPackage; manifest: PrivateDocumentManifest }> {
  const value = await DocumentHostingService.package(session, requestId, signal);
  await verifyHostedPackage(session, value);
  if (value.terms.requestId !== requestId) throw new Error("document_package_invalid");
  const descriptors = value.artifacts.filter(item => item.role === "manifest" && item.fileRef === null);
  if (descriptors.length !== 1) throw new Error("document_manifest_unavailable");
  const bytes = await openHostedArtifact(session, requestId, value, descriptors[0]!, signal);
  try {
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as PrivateDocumentManifest;
    if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 25 || new Set(manifest.files.map(file => file.fileRef)).size !== manifest.files.length ||
        manifest.files.some(file => typeof file.name !== "string" || !file.name || file.name.length > 1024 || file.mimeType !== "application/pdf" || typeof file.sourceRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(file.sourceSha256) || !/^[a-f0-9]{64}$/.test(file.watermarkedSha256) ||
          !value.artifacts.some(item => item.artifactId === file.originalArtifactId && item.fileRef === file.fileRef && item.role === "original") ||
          !value.artifacts.some(item => item.artifactId === file.watermarkedArtifactId && item.fileRef === file.fileRef && item.role === "watermarked"))) throw new Error("document_manifest_invalid");
    requireDocumentSession(session, signal);
    return { package: value, manifest };
  } finally { bytes.fill(0); }
}
export const hostedDocumentContentHash = (file: PrivateDocumentManifest["files"][number], role: "original" | "watermarked") => role === "original" ? file.sourceSha256 : file.watermarkedSha256;
export { canonicalDocumentJson };

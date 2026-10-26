// @vitest-environment node
import { webcrypto } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalDocumentJson, decryptDocumentArtifact, documentContentCommitment, documentHash, documentPackageDigest, documentWrapDigests, encryptDocumentArtifact, unwrapDocumentKey, wrapDocumentKey, documentWrapAad, documentContentAad, protectDocumentOwnerKey, recoverDocumentOwnerKey, type DocumentTerms, type DocumentWrap } from "@/lib/consent/document-hosting-crypto";
import { bytesToBase64 } from "@/lib/vault/base64";
const recoveryService = vi.hoisted(() => ({ ownerPackage: vi.fn(), recoveryRecipientKey: vi.fn(), recoveryAmendment: vi.fn() }));
vi.mock("@/lib/services/document-hosting-service", () => ({ DocumentHostingService: recoveryService, requireDocumentSession: (session: { isCurrent(): boolean }, signal?: AbortSignal) => { signal?.throwIfAborted(); if (!session.isCurrent()) throw new DOMException("Session changed", "AbortError"); } }));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: {} }));
vi.mock("@/lib/services/drive-device-source-service", () => ({ DriveDeviceSourceService: {} }));
vi.mock("@/lib/consent/document-hosting-pdf", () => ({ prepareHostedPdf: vi.fn() }));
import { repairHostedRecipientKey } from "@/lib/consent/document-hosting-preparation";
import { connectorKeyFingerprint } from "@/lib/consent/export-envelope-v2";
import type { DocumentSession, HostedTermsProjection } from "@/lib/services/document-hosting-service";
beforeAll(() => { vi.stubGlobal("crypto", webcrypto); });
describe("@feature_one_document_hosting document envelope", () => {
  it("authenticates exact bytes, role, file and generation, with a tamper negative control", async () => {
    const original = new Uint8Array([37, 80, 68, 70, 45, 0, 255, 128]);
    const encrypted = await encryptDocumentArtifact({ bytes: original, artifactId: crypto.randomUUID(), fileRef: "file-1", role: "original", preparationDigest: "a".repeat(64) });
    expect(encrypted.ciphertext).not.toEqual(original);
    expect(documentContentAad("a".repeat(64), encrypted.descriptor)).toBe(documentContentAad("a".repeat(64), { artifactId: encrypted.descriptor.artifactId, fileRef: encrypted.descriptor.fileRef, role: encrypted.descriptor.role }));
    expect(await decryptDocumentArtifact(encrypted.ciphertext, encrypted.descriptor, "a".repeat(64), encrypted.keyHex)).toEqual(original);
    await expect(decryptDocumentArtifact(encrypted.ciphertext, { ...encrypted.descriptor, role: "watermarked" }, "a".repeat(64), encrypted.keyHex)).rejects.toThrow();
    await expect(decryptDocumentArtifact(encrypted.ciphertext, encrypted.descriptor, "b".repeat(64), encrypted.keyHex)).rejects.toThrow();
    const broken = new Uint8Array(encrypted.ciphertext); broken[0] = broken[0]! ^ 1;
    await expect(decryptDocumentArtifact(broken, encrypted.descriptor, "a".repeat(64), encrypted.keyHex)).rejects.toThrow("document_integrity_failed");
  });
  it("wraps for the exact recipient and terms while content stays immutable", async () => {
    const pair = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]) as CryptoKeyPair;
    const publicKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const privateKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
    const terms: DocumentTerms = { version: 1, revision: 1, requestId: crypto.randomUUID(), ownerUserId: "a", recipientUserId: "b", receiveThrough: "one", contentCommitment: "a".repeat(64), amountCents: 50, currency: "usd", accessExpiresAt: "2026-11-01T00:00:00Z", rights: { preview: true, download: true }, activityDisclosureVersion: "one-document-activity-v1", copyDisclosureVersion: "one-document-copy-v1", recipientKeyId: "key-b", recipientKeyFingerprint: "b".repeat(64) };
    const t = await documentHash(terms);
    const wrapped = await wrapDocumentKey({ keyHex: "c".repeat(64), artifactId: "artifact", contentCommitment: terms.contentCommitment, termsDigest: t, terms, publicKey });
    if (wrapped.role !== "recipient") throw new Error();
    const connector = { connector_key_id: "key-b", connector_public_key: publicKey, connector_private_key: privateKey };
    expect(await unwrapDocumentKey(wrapped.bundle, connector, documentWrapAad(terms.contentCommitment, t, "artifact", terms))).toBe("c".repeat(64));
    await expect(unwrapDocumentKey(wrapped.bundle, connector, documentWrapAad(terms.contentCommitment, "d".repeat(64), "artifact", terms))).rejects.toThrow();
    await expect(unwrapDocumentKey(wrapped.bundle, { ...connector, connector_key_id: "other" }, "")).rejects.toThrow("document_key_unavailable");
    expect(await documentPackageDigest(terms.contentCommitment, t, [wrapped])).toHaveLength(64);
    expect(await documentContentCommitment("a".repeat(64), [])).toHaveLength(64);
  });
  it("recovers only an owner-vault-bound key without exposing a readable server key", async () => {
    const context = canonicalDocumentJson({ purpose: "one-document-owner-recovery", preparationDigest: "a".repeat(64), artifactId: "original", ownerUserId: "a", version: 1 });
    const protectedKey = await protectDocumentOwnerKey("c".repeat(64), "a".repeat(64), context);
    expect(await recoverDocumentOwnerKey(protectedKey, "a".repeat(64), context)).toBe("c".repeat(64));
    await expect(recoverDocumentOwnerKey(protectedKey, "b".repeat(64), context)).rejects.toThrow();
    await expect(recoverDocumentOwnerKey(protectedKey, "a".repeat(64), context.replace("original", "other"))).rejects.toThrow();
  });
  it("has deterministic canonical serialization and rejects undefined or fractional values", () => {
    expect(canonicalDocumentJson({ z: null, a: { b: 2, a: true } })).toBe('{"a":{"a":true,"b":2},"z":null}');
    expect(() => canonicalDocumentJson({ a: undefined })).toThrow();
    expect(() => canonicalDocumentJson({ a: 1.5 })).toThrow();
  });
});


describe("@feature_one_document_hosting owner-only recovery response", () => {
  beforeEach(() => vi.clearAllMocks());
  const session: DocumentSession = { userId: "owner-a", vaultKey: "a".repeat(64), vaultOwnerToken: "owner-proof", isCurrent: () => true };
  async function fixture() {
    const requestId = crypto.randomUUID(), preparationDigest = "1".repeat(64), fileRef = crypto.randomUUID();
    const originalRecipient = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]) as CryptoKeyPair;
    const originalPublicKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", originalRecipient.publicKey)));
    const replacements = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]) as CryptoKeyPair;
    const publicKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", replacements.publicKey)));
    const connector = { connector_key_id: "replacement-b", connector_public_key: publicKey, connector_private_key: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", replacements.privateKey))) };
    const sealed = await Promise.all((["original", "watermarked", "manifest"] as const).map(role => encryptDocumentArtifact({ bytes: new TextEncoder().encode(role), artifactId: crypto.randomUUID(), fileRef: role === "manifest" ? null : fileRef, role, preparationDigest })));
    const artifacts = sealed.map(item => item.descriptor), contentCommitment = await documentContentCommitment(preparationDigest, artifacts);
    const terms: DocumentTerms = { version: 1, revision: 1, requestId, ownerUserId: session.userId, recipientUserId: "recipient-b", receiveThrough: "one", contentCommitment, amountCents: 50, currency: "usd", accessExpiresAt: "2099-01-01T00:00:00Z", rights: { preview: true, download: true }, activityDisclosureVersion: "one-document-activity-v1", copyDisclosureVersion: "one-document-copy-v1", recipientKeyId: "original-b", recipientKeyFingerprint: (await connectorKeyFingerprint(originalPublicKey)).replace(/^sha256:/, "") };
    const termsDigest = await documentHash(terms), complete: DocumentWrap[] = [];
    for (const item of sealed) {
      complete.push(await wrapDocumentKey({ keyHex: item.keyHex, artifactId: item.descriptor.artifactId, contentCommitment, termsDigest, terms, publicKey: originalPublicKey }));
      complete.push({ artifactId: item.descriptor.artifactId, role: "owner_recovery", bundle: await protectDocumentOwnerKey(item.keyHex, session.vaultKey, canonicalDocumentJson({ version: 1, purpose: "one-document-owner-recovery", preparationDigest, artifactId: item.descriptor.artifactId, ownerUserId: session.userId })) });
    }
    const packageDigest = await documentPackageDigest(contentCommitment, termsDigest, complete);
    // Actual owner response: only A envelopes, with commitments for the withheld B envelopes.
    const previous = { terms, termsDigest, packageDigest, originalTermsDigest: "3".repeat(64), originalPackageDigest: "4".repeat(64), preparationDigest, contentCommitment, artifacts,
      wraps: complete.filter(item => item.role === "owner_recovery"), wrapDigests: (await documentWrapDigests(complete)).reverse(), accessExpiresAt: terms.accessExpiresAt };
    const projection = { requestId, revision: 3, ownerUserId: session.userId, recipientUserId: terms.recipientUserId, accessExpiresAt: terms.accessExpiresAt, contentCommitment, termsDigest, packageDigest } as HostedTermsProjection;
    recoveryService.ownerPackage.mockResolvedValue(previous);
    recoveryService.recoveryRecipientKey.mockResolvedValue({ connectorKeyId: connector.connector_key_id, connectorPublicKey: publicKey, connectorWrappingAlg: "X25519-AES256-GCM", publicKeyFingerprint: (await connectorKeyFingerprint(publicKey)).replace(/^sha256:/, "") });
    recoveryService.recoveryAmendment.mockResolvedValue(projection);
    return { requestId, projection, previous, connector, sealed };
  }
  it("rewraps a real owner-only response without requesting B envelopes, preserving paid provenance and all content terms", async () => {
    const value = await fixture();
    await repairHostedRecipientKey(session, value.requestId, value.projection, new AbortController().signal);
    const body = recoveryService.recoveryAmendment.mock.calls[0]![2];
    expect(body.originalTermsDigest).toBe(value.previous.originalTermsDigest); expect(body.originalPackageDigest).toBe(value.previous.originalPackageDigest);
    expect(body.terms).toEqual({ ...value.previous.terms, revision: value.projection.revision + 1, recipientKeyId: value.connector.connector_key_id, recipientKeyFingerprint: (await connectorKeyFingerprint(value.connector.connector_public_key)).replace(/^sha256:/, "") });
    expect(body.wraps.filter((item: DocumentWrap) => item.role === "owner_recovery")).toEqual(value.previous.wraps);
    expect(await documentPackageDigest(body.terms.contentCommitment, body.termsDigest, body.wraps)).toBe(body.packageDigest);
    for (const item of value.sealed) {
      const recipient = body.wraps.find((wrap: DocumentWrap) => wrap.role === "recipient" && wrap.artifactId === item.descriptor.artifactId);
      expect(await unwrapDocumentKey(recipient.bundle, value.connector, documentWrapAad(value.previous.contentCommitment, body.termsDigest, item.descriptor.artifactId, body.terms))).toBe(item.keyHex);
    }
  });
  it("rejects altered package commitments, altered A envelopes and changed deadlines before any amendment", async () => {
    const value = await fixture();
    for (const previous of [
      { ...value.previous, wrapDigests: value.previous.wrapDigests.slice(1) },
      { ...value.previous, wraps: value.previous.wraps.map((wrap, index) => index ? wrap : { ...wrap, bundle: { ...wrap.bundle, tag: bytesToBase64(new Uint8Array(16)) } }) },
      { ...value.previous, accessExpiresAt: "2098-01-01T00:00:00Z" },
    ]) {
      recoveryService.ownerPackage.mockResolvedValue(previous);
      await expect(repairHostedRecipientKey(session, value.requestId, value.projection, new AbortController().signal)).rejects.toThrow("document_package_invalid");
    }
    expect(recoveryService.recoveryRecipientKey).not.toHaveBeenCalled(); expect(recoveryService.recoveryAmendment).not.toHaveBeenCalled();
  });
});

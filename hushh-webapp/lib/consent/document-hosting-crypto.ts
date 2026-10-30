import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";
import { wrapExportKeyForConnector, unwrapExportKeyForConnector, type WrappedExportKeyBundle } from "@/lib/vault/export-encrypt";

export const DOCUMENT_FILE_LIMIT = 4 * 1024 * 1024;
export const DOCUMENT_CIPHERTEXT_LIMIT = DOCUMENT_FILE_LIMIT + 128 * 1024;
export type DocumentRole = "original" | "watermarked" | "manifest";
export type DocumentDescriptor = {
  artifactId: string; fileRef: string | null; role: DocumentRole; iv: string;
  plaintextBytes: number; ciphertextBytes: number; ciphertextSha256: string;
};
export type DocumentTerms = {
  version: 1; revision: number; requestId: string; ownerUserId: string; recipientUserId: string;
  receiveThrough: "one" | "both"; contentCommitment: string; amountCents: number; currency: "usd";
  accessExpiresAt: string; rights: { preview: true; download: true };
  activityDisclosureVersion: string; copyDisclosureVersion: string;
  recipientKeyId: string; recipientKeyFingerprint: string;
};
export type DocumentWrap = {
  artifactId: string; role: "recipient"; recipientKeyId: string; recipientKeyFingerprint: string;
  bundle: WrappedExportKeyBundle;
} | { artifactId: string; role: "owner_recovery"; bundle: { ciphertext: string; iv: string; tag: string } };
export type DocumentConnector = { connector_key_id: string; connector_public_key: string; connector_private_key: string };
const buffer = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer;
const hex = (value: Uint8Array) => Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
function unhex(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("document_key_invalid");
  return Uint8Array.from(value.match(/../g)!, part => parseInt(part, 16));
}

/** Frozen F1: ASCII keys, compact UTF-8, finite integers, explicit nulls. */
export function canonicalDocumentJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isSafeInteger(item)) return item;
    if (Array.isArray(item)) return item.map(visit);
    if (typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype)
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => {
        if (!/^[\x20-\x7e]+$/.test(key)) throw new Error("document_context_invalid");
        return [key, visit(entry)];
      }));
    throw new Error("document_context_invalid");
  };
  return JSON.stringify(visit(value));
}
export async function documentHash(value: Uint8Array | unknown): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(canonicalDocumentJson(value));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(bytes))));
}
export function documentContentAad(preparationDigest: string, descriptor: Pick<DocumentDescriptor, "artifactId" | "fileRef" | "role">): string {
  return canonicalDocumentJson({ version: 1, purpose: "one-document-content", preparationDigest, artifactId: descriptor.artifactId, fileRef: descriptor.fileRef, role: descriptor.role });
}
export function documentWrapAad(contentCommitment: string, termsDigest: string, artifactId: string, terms: Pick<DocumentTerms, "recipientUserId" | "recipientKeyId" | "recipientKeyFingerprint">): string {
  return canonicalDocumentJson({ version: 1, purpose: "one-document-recipient-key", contentCommitment, termsDigest, artifactId,
    recipientUserId: terms.recipientUserId, recipientKeyId: terms.recipientKeyId, recipientKeyFingerprint: terms.recipientKeyFingerprint });
}
async function aes(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buffer(keyBytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptDocumentArtifact(input: {
  bytes: Uint8Array; artifactId: string; fileRef: string | null; role: DocumentRole; preparationDigest: string;
}): Promise<{ descriptor: DocumentDescriptor; ciphertext: Uint8Array; keyHex: string }> {
  if (!input.bytes.length || input.bytes.length > DOCUMENT_FILE_LIMIT) throw new Error("document_size_invalid");
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const identity = { artifactId: input.artifactId, fileRef: input.fileRef, role: input.role };
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(iv),
      additionalData: new TextEncoder().encode(documentContentAad(input.preparationDigest, identity)) }, await aes(rawKey), buffer(input.bytes)));
    return { ciphertext, keyHex: hex(rawKey), descriptor: { ...identity, iv: bytesToBase64(iv),
      plaintextBytes: input.bytes.length, ciphertextBytes: ciphertext.length, ciphertextSha256: await documentHash(ciphertext) } };
  } finally { rawKey.fill(0); }
}
export async function decryptDocumentArtifact(ciphertext: Uint8Array, descriptor: DocumentDescriptor, preparationDigest: string, keyHex: string): Promise<Uint8Array> {
  if (ciphertext.length !== descriptor.ciphertextBytes || ciphertext.length > DOCUMENT_CIPHERTEXT_LIMIT ||
      descriptor.plaintextBytes < 1 || descriptor.plaintextBytes > DOCUMENT_FILE_LIMIT ||
      ciphertext.length !== descriptor.plaintextBytes + 16 || await documentHash(ciphertext) !== descriptor.ciphertextSha256)
    throw new Error("document_integrity_failed");
  const key = unhex(keyHex);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(base64ToBytes(descriptor.iv)),
      additionalData: new TextEncoder().encode(documentContentAad(preparationDigest, { artifactId: descriptor.artifactId, fileRef: descriptor.fileRef, role: descriptor.role })) }, await aes(key), buffer(ciphertext)));
  } finally { key.fill(0); }
}
export async function wrapDocumentKey(input: { keyHex: string; artifactId: string; contentCommitment: string; termsDigest: string; terms: DocumentTerms; publicKey: string }): Promise<DocumentWrap> {
  return { artifactId: input.artifactId, role: "recipient", recipientKeyId: input.terms.recipientKeyId,
    recipientKeyFingerprint: input.terms.recipientKeyFingerprint,
    bundle: await wrapExportKeyForConnector({ exportKeyHex: input.keyHex, connectorPublicKey: input.publicKey,
      connectorKeyId: input.terms.recipientKeyId, additionalData: documentWrapAad(input.contentCommitment, input.termsDigest, input.artifactId, input.terms) }) };
}

/** Byte/key unwrap shares the existing connector's X25519-SHA256-AES-GCM profile. */
export async function unwrapDocumentKey(bundle: WrappedExportKeyBundle, connector: DocumentConnector, context: string): Promise<string> {
  const opened = await unwrapExportKeyForConnector({ bundle, connectorKeyId: connector.connector_key_id,
    connectorPrivateKey: connector.connector_private_key, ...(context ? { additionalData: context } : {}) });
  try { return hex(opened); } finally { opened.fill(0); }
}

export async function documentContentCommitment(preparationDigest: string, artifacts: DocumentDescriptor[]): Promise<string> {
  return documentHash({ version: 1, preparationDigest, artifacts: [...artifacts].sort((a, b) => a.artifactId.localeCompare(b.artifactId)) });
}
export async function documentWrapDigests(wraps: DocumentWrap[]): Promise<Array<{ artifactId: string; role: DocumentWrap["role"]; sha256: string }>> {
  return Promise.all([...wraps].sort((a, b) => a.artifactId.localeCompare(b.artifactId) || a.role.localeCompare(b.role))
    .map(async wrap => ({ artifactId: wrap.artifactId, role: wrap.role, sha256: await documentHash(wrap) })));
}
export async function documentPackageDigestFromWrapDigests(contentCommitment: string, termsDigest: string, wrapDigests: Array<{ artifactId: string; role: string; sha256: string }>): Promise<string> {
  return documentHash({ version: 1, contentCommitment, termsDigest,
    wraps: [...wrapDigests].sort((a, b) => a.artifactId.localeCompare(b.artifactId) || a.role.localeCompare(b.role)) });
}
export async function documentPackageDigest(contentCommitment: string, termsDigest: string, wraps: DocumentWrap[]): Promise<string> {
  return documentPackageDigestFromWrapDigests(contentCommitment, termsDigest, await documentWrapDigests(wraps));
}

export async function protectDocumentOwnerKey(keyHex: string, vaultKey: string, context: string): Promise<{ ciphertext: string; iv: string; tag: string }> {
  const raw = unhex(vaultKey), iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(iv), additionalData: new TextEncoder().encode(context) }, await aes(raw), new TextEncoder().encode(keyHex)));
    return { ciphertext: bytesToBase64(cipher.slice(0, -16)), iv: bytesToBase64(iv), tag: bytesToBase64(cipher.slice(-16)) };
  } finally { raw.fill(0); }
}

export async function recoverDocumentOwnerKey(bundle: { ciphertext: string; iv: string; tag: string }, vaultKey: string, context: string): Promise<string> {
  const raw = unhex(vaultKey); const cipher = base64ToBytes(bundle.ciphertext), tag = base64ToBytes(bundle.tag);
  const combined = new Uint8Array(cipher.length + tag.length); combined.set(cipher); combined.set(tag, cipher.length);
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(base64ToBytes(bundle.iv)),
      additionalData: new TextEncoder().encode(context) }, await aes(raw), buffer(combined)));
    try { const key = new TextDecoder("utf-8", { fatal: true }).decode(plain); unhex(key).fill(0); return key; } finally { plain.fill(0); }
  } finally { raw.fill(0); combined.fill(0); }
}

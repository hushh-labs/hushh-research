"use client";

/**
 * Browser half of the isolated Connected Systems `crm-zk.v1` protocol.
 *
 * This does not reuse the consent-export crypto profile: CRM ZK derives its
 * wrapping key with HKDF-SHA256 and the exact `crm-zk.v1:key-wrap` info value.
 * CRM values and request-ephemeral X25519 private keys remain in runtime
 * memory; the long-lived P-256 owner signing private key is encrypted in PKM.
 */

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { ConnectedSystemsService } from "@/lib/services/connected-systems-service";
import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";

export const CRM_ZK_V1_PROFILE = "crm-zk.v1" as const;
export const CRM_ZK_OWNER_SIGNING_PKM_DOMAIN = "connected_systems_crypto" as const;

export type CrmZkConfiguration = {
  profile: typeof CRM_ZK_V1_PROFILE;
  hkdf: { hash: "SHA-256"; salt: string; info: "crm-zk.v1:key-wrap"; lengthBytes: 32 };
  configurationRevision: number;
  recipientKey: { keyId: string; publicKey: string; fingerprint: string };
  responseSigningKey: { keyId: string; publicKey: string; fingerprint: string; algorithm: string };
};

export type CrmZkContext = {
  profile: typeof CRM_ZK_V1_PROFILE;
  contextId: string;
  contextDigest: string;
  systemId: string;
  operation: "read" | "update";
  objectType: string;
  fieldNames: string[];
  schemaFingerprint?: string | null;
  configurationRevision: number;
  recipientKeyId: string;
  recipientKeyFingerprint: string;
  clientOperationId: string;
  expiresAtMs: number;
};

export type CrmZkOwnerSigningKey = {
  key_id: string;
  public_key_spki: string;
  private_key_pkcs8: string;
  public_key_fingerprint: string;
  created_at: string;
};

export type CrmZkEncryptedFields = {
  profile: typeof CRM_ZK_V1_PROFILE;
  direction: "read_request" | "update_request";
  recipientKeyId: string;
  recipientKeyFingerprint: string;
  clientEphemeralPublicKey: string;
  envelopeId: string;
  contextId: string;
  contextDigest: string;
  clientOperationId: string;
  expiresAtMs: number;
  wrappedPayloadKey: string;
  wrappedKeyIv: string;
  wrappedKeyTag: string;
  payloadIv: string;
  payloadTag: string;
  ciphertext: string;
  aadSha256: string;
  ownerSignerKeyId: string;
  ownerSignature: string;
  readNonce?: string;
};

export type CrmZkPartnerResponseEnvelope = {
  profile: typeof CRM_ZK_V1_PROFILE;
  direction: "read_response" | "update_response";
  contextId: string;
  contextDigest: string;
  envelopeId: string;
  clientOperationId: string;
  expiresAtMs: number;
  recipientClientEphemeralPublicKey: string;
  wrappedPayloadKey: string;
  wrappedKeyIv: string;
  wrappedKeyTag: string;
  payloadIv: string;
  payloadTag: string;
  ciphertext: string;
  aadSha256: string;
  responseSignerKeyId: string;
  responseSignature: string;
};

type EphemeralKey = { privateKey: CryptoKey; publicKey: string; expiresAtMs: number };
const ephemeralKeys = new Map<string, EphemeralKey>();

export function discardCrmZkEphemeralKey(contextId: string): boolean {
  return ephemeralKeys.delete(contextId);
}

export function clearCrmZkEphemeralKeys(): void {
  ephemeralKeys.clear();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  crypto.getRandomValues(value);
  return value;
}

function randomId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
}

function splitCiphertextAndTag(value: ArrayBuffer): { ciphertext: Uint8Array; tag: Uint8Array } {
  const bytes = new Uint8Array(value);
  if (bytes.byteLength < 17) throw new Error("CRM ZK encryption produced an invalid AES-GCM result.");
  return { ciphertext: bytes.slice(0, -16), tag: bytes.slice(-16) };
}

function combineCiphertextAndTag(ciphertext: string, tag: string): ArrayBuffer {
  const left = base64ToBytes(ciphertext);
  const right = base64ToBytes(tag);
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return toArrayBuffer(combined);
}

function assertPortableJson(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("CRM ZK metadata must use safe integer values.");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertPortableJson);
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
      if (typeof key !== "string") throw new Error("CRM ZK JSON keys must be strings.");
      assertPortableJson(item);
    });
    return;
  }
  throw new Error("CRM ZK metadata must be JSON-compatible.");
}

function sortJson(value: unknown): unknown {
  assertPortableJson(value);
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = sortJson((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

/** Matches Python `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)`. */
export function canonicalCrmZkJson(value: unknown): string {
  return JSON.stringify(sortJson(value)).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

async function sha256Digest(bytes: Uint8Array | string): Promise<string> {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(input)));
  return `sha256:${Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function normalizedEnvelopeForSignature(envelope: Omit<CrmZkEncryptedFields, "ownerSignature">): Record<string, unknown> {
  // The API parser normalizes transport camelCase to these snake_case keys
  // before canonicalizing. Keep this exact mapping in Java conformance vectors.
  return {
    profile: envelope.profile,
    direction: envelope.direction,
    recipient_key_id: envelope.recipientKeyId,
    recipient_key_fingerprint: envelope.recipientKeyFingerprint,
    client_ephemeral_public_key: envelope.clientEphemeralPublicKey,
    envelope_id: envelope.envelopeId,
    context_id: envelope.contextId,
    context_digest: envelope.contextDigest,
    client_operation_id: envelope.clientOperationId,
    expires_at_ms: envelope.expiresAtMs,
    wrapped_payload_key: envelope.wrappedPayloadKey,
    wrapped_key_iv: envelope.wrappedKeyIv,
    wrapped_key_tag: envelope.wrappedKeyTag,
    payload_iv: envelope.payloadIv,
    payload_tag: envelope.payloadTag,
    ciphertext: envelope.ciphertext,
    aad_sha256: envelope.aadSha256,
    owner_signer_key_id: envelope.ownerSignerKeyId,
    read_nonce: envelope.readNonce ?? null,
  };
}

function normalizedResponseForSignature(envelope: CrmZkPartnerResponseEnvelope): Record<string, unknown> {
  return {
    profile: envelope.profile,
    direction: envelope.direction,
    context_id: envelope.contextId,
    context_digest: envelope.contextDigest,
    envelope_id: envelope.envelopeId,
    client_operation_id: envelope.clientOperationId,
    expires_at_ms: envelope.expiresAtMs,
    recipient_client_ephemeral_public_key: envelope.recipientClientEphemeralPublicKey,
    wrapped_payload_key: envelope.wrappedPayloadKey,
    wrapped_key_iv: envelope.wrappedKeyIv,
    wrapped_key_tag: envelope.wrappedKeyTag,
    payload_iv: envelope.payloadIv,
    payload_tag: envelope.payloadTag,
    ciphertext: envelope.ciphertext,
    aad_sha256: envelope.aadSha256,
    response_signer_key_id: envelope.responseSignerKeyId,
  };
}

function aadForContext(params: {
  context: CrmZkContext;
  direction: CrmZkEncryptedFields["direction"] | CrmZkPartnerResponseEnvelope["direction"];
  clientEphemeralPublicKey: string;
  readNonce?: string;
}): Record<string, unknown> {
  const aad: Record<string, unknown> = {
    profile: CRM_ZK_V1_PROFILE,
    direction: params.direction,
    systemId: params.context.systemId,
    operation: params.context.operation,
    objectType: params.context.objectType,
    fieldNames: params.context.fieldNames,
    schemaFingerprint: params.context.schemaFingerprint ?? null,
    configurationRevision: params.context.configurationRevision,
    recipientKeyId: params.context.recipientKeyId,
    recipientKeyFingerprint: params.context.recipientKeyFingerprint,
    contextId: params.context.contextId,
    contextDigest: params.context.contextDigest,
    clientOperationId: params.context.clientOperationId,
    expiresAtMs: params.context.expiresAtMs,
    clientEphemeralPublicKey: params.clientEphemeralPublicKey,
  };
  if (params.readNonce !== undefined) aad.readNonce = params.readNonce;
  return aad;
}

function ownerRecord(value: unknown): CrmZkOwnerSigningKey | null {
  const active = value && typeof value === "object" && "active" in value
    ? (value as { active?: unknown }).active
    : null;
  if (!active || typeof active !== "object") return null;
  const record = active as Partial<CrmZkOwnerSigningKey>;
  return record.key_id && record.public_key_spki && record.private_key_pkcs8 && record.public_key_fingerprint
    ? record as CrmZkOwnerSigningKey
    : null;
}

async function generateOwnerSigningKey(): Promise<CrmZkOwnerSigningKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const publicKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  const privateKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  const fingerprint = await sha256Digest(base64ToBytes(publicKey));
  return {
    key_id: `cszk-owner-${fingerprint.slice("sha256:".length, "sha256:".length + 20)}`,
    public_key_spki: publicKey,
    private_key_pkcs8: privateKey,
    public_key_fingerprint: fingerprint,
    created_at: new Date().toISOString(),
  };
}

export async function ensureCrmZkOwnerSigningKey(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  systemId: string;
}): Promise<CrmZkOwnerSigningKey> {
  const existing = await PkmDomainResourceService.getStaleFirst({
    userId: params.userId,
    domain: CRM_ZK_OWNER_SIGNING_PKM_DOMAIN,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    backgroundRefresh: false,
  }).then((snapshot) => ownerRecord(snapshot?.data)).catch(() => null);
  const key = existing || await generateOwnerSigningKey();
  if (!existing) {
    const saved = await PkmWriteCoordinator.saveMergedDomain({
      userId: params.userId,
      domain: CRM_ZK_OWNER_SIGNING_PKM_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      confirmation: { confirmedByUser: true, surface: "web", source: "connected_systems_crm_zk_key_setup" },
      build: () => ({
        domainData: { active: key, schema_version: 1, updated_at: new Date().toISOString() },
        summary: { key_id: key.key_id, public_key_fingerprint: key.public_key_fingerprint },
      }),
    });
    if (!saved.success) throw new Error(saved.message || "Unable to save your CRM signing key in the vault.");
  }
  await ConnectedSystemsService.registerCrmZkOwnerSigningKey({
    vaultOwnerToken: params.vaultOwnerToken,
    systemId: params.systemId,
    keyId: key.key_id,
    publicKeySpki: key.public_key_spki,
  });
  return key;
}

async function importOwnerPrivateKey(key: CrmZkOwnerSigningKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8", toArrayBuffer(base64ToBytes(key.private_key_pkcs8)),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
}

async function signOwner(key: CrmZkOwnerSigningKey, payload: Record<string, unknown>): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, await importOwnerPrivateKey(key),
    new TextEncoder().encode(canonicalCrmZkJson(payload))
  );
  return bytesToBase64(new Uint8Array(signature));
}

export async function createCrmZkEnvelope(params: {
  context: CrmZkContext;
  configuration: CrmZkConfiguration;
  ownerSigningKey: CrmZkOwnerSigningKey;
  payload: Record<string, unknown>;
}): Promise<CrmZkEncryptedFields> {
  const direction = `${params.context.operation}_request` as CrmZkEncryptedFields["direction"];
  if (params.context.profile !== CRM_ZK_V1_PROFILE || params.configuration.profile !== CRM_ZK_V1_PROFILE) {
    throw new Error("CRM ZK profile mismatch.");
  }
  if (
    params.context.configurationRevision !== params.configuration.configurationRevision ||
    params.context.recipientKeyId !== params.configuration.recipientKey.keyId ||
    params.context.recipientKeyFingerprint !== params.configuration.recipientKey.fingerprint
  ) {
    throw new Error("CRM ZK connector changed. Start a fresh request.");
  }
  if (params.context.expiresAtMs <= Date.now()) throw new Error("CRM ZK context expired. Start again.");
  const x25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
  let pair: CryptoKeyPair;
  try {
    pair = await crypto.subtle.generateKey(x25519, true, ["deriveBits"]) as CryptoKeyPair;
  } catch {
    throw new Error("This device does not support the required CRM ZK cryptography.");
  }
  const publicKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const recipient = await crypto.subtle.importKey("raw", toArrayBuffer(base64ToBytes(params.configuration.recipientKey.publicKey)), x25519, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: recipient } as unknown as AlgorithmIdentifier, pair.privateKey, 256);
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(new Uint8Array(32)), info: new TextEncoder().encode("crm-zk.v1:key-wrap") },
    await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]),
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
  const readNonce = params.context.operation === "read" ? bytesToBase64(randomBytes(32)) : undefined;
  const aad = aadForContext({ context: params.context, direction, clientEphemeralPublicKey: publicKey, readNonce });
  const aadBytes = new TextEncoder().encode(canonicalCrmZkJson(aad));
  const payloadKeyBytes = randomBytes(32);
  const payloadKey = await crypto.subtle.importKey("raw", toArrayBuffer(payloadKeyBytes), { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const wrappedKeyIv = randomBytes(12);
  const payloadIv = randomBytes(12);
  const wrapped = splitCiphertextAndTag(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(wrappedKeyIv), additionalData: toArrayBuffer(aadBytes) }, wrappingKey, toArrayBuffer(payloadKeyBytes)
  ));
  const plaintext = params.context.operation === "read"
    ? { readNonce }
    : { recordFields: params.payload };
  const encrypted = splitCiphertextAndTag(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(payloadIv), additionalData: toArrayBuffer(aadBytes) }, payloadKey,
    new TextEncoder().encode(canonicalCrmZkJson(plaintext))
  ));
  const unsigned: Omit<CrmZkEncryptedFields, "ownerSignature"> = {
    profile: CRM_ZK_V1_PROFILE, direction,
    recipientKeyId: params.context.recipientKeyId,
    recipientKeyFingerprint: params.context.recipientKeyFingerprint,
    clientEphemeralPublicKey: publicKey,
    envelopeId: randomId("czke_"),
    contextId: params.context.contextId,
    contextDigest: params.context.contextDigest,
    clientOperationId: params.context.clientOperationId,
    expiresAtMs: params.context.expiresAtMs,
    wrappedPayloadKey: bytesToBase64(wrapped.ciphertext),
    wrappedKeyIv: bytesToBase64(wrappedKeyIv),
    wrappedKeyTag: bytesToBase64(wrapped.tag),
    payloadIv: bytesToBase64(payloadIv),
    payloadTag: bytesToBase64(encrypted.tag),
    ciphertext: bytesToBase64(encrypted.ciphertext),
    aadSha256: await sha256Digest(aadBytes),
    ownerSignerKeyId: params.ownerSigningKey.key_id,
    ...(readNonce ? { readNonce } : {}),
  };
  const ownerSignature = await signOwner(params.ownerSigningKey, normalizedEnvelopeForSignature(unsigned));
  ephemeralKeys.set(params.context.contextId, { privateKey: pair.privateKey, publicKey, expiresAtMs: params.context.expiresAtMs });
  return { ...unsigned, ownerSignature };
}

export async function signCrmZkApproval(params: {
  ownerSigningKey: CrmZkOwnerSigningKey;
  intentId: string;
  envelopeDigest: string;
  challengeId: string;
  nonce: string;
  expiresAtMs: number;
}): Promise<Record<string, unknown>> {
  const unsigned = {
    intent_id: params.intentId,
    envelope_digest: params.envelopeDigest,
    challenge_id: params.challengeId,
    nonce: params.nonce,
    expires_at_ms: params.expiresAtMs,
    owner_signer_key_id: params.ownerSigningKey.key_id,
  };
  return {
    intentId: params.intentId,
    envelopeDigest: params.envelopeDigest,
    challengeId: params.challengeId,
    nonce: params.nonce,
    expiresAtMs: params.expiresAtMs,
    ownerSignerKeyId: params.ownerSigningKey.key_id,
    signature: await signOwner(params.ownerSigningKey, unsigned),
  };
}

export async function decryptCrmZkPartnerResponse(params: {
  context: CrmZkContext;
  configuration: CrmZkConfiguration;
  response: CrmZkPartnerResponseEnvelope;
}): Promise<Record<string, unknown>> {
  const ephemeral = ephemeralKeys.get(params.context.contextId);
  if (!ephemeral || ephemeral.expiresAtMs <= Date.now()) {
    ephemeralKeys.delete(params.context.contextId);
    throw new Error("This encrypted CRM response can no longer be opened. Start a fresh bound read.");
  }
  try {
    if (
      params.response.profile !== CRM_ZK_V1_PROFILE ||
      params.response.contextId !== params.context.contextId ||
      params.response.contextDigest !== params.context.contextDigest ||
      params.response.clientOperationId !== params.context.clientOperationId ||
      params.response.recipientClientEphemeralPublicKey !== ephemeral.publicKey ||
      params.response.responseSignerKeyId !== params.configuration.responseSigningKey.keyId ||
      params.response.expiresAtMs <= Date.now()
    ) throw new Error("CRM ZK response metadata did not match the request.");
    const signatureKey = await crypto.subtle.importKey("spki", toArrayBuffer(base64ToBytes(params.configuration.responseSigningKey.publicKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const signatureValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, signatureKey, toArrayBuffer(base64ToBytes(params.response.responseSignature)),
      new TextEncoder().encode(canonicalCrmZkJson(normalizedResponseForSignature(params.response)))
    );
    if (!signatureValid) throw new Error("CRM ZK response signature was invalid.");
    const responseAad = aadForContext({
      context: params.context,
      direction: params.response.direction,
      clientEphemeralPublicKey: ephemeral.publicKey,
    });
    const aadBytes = new TextEncoder().encode(canonicalCrmZkJson(responseAad));
    if ((await sha256Digest(aadBytes)) !== params.response.aadSha256) throw new Error("CRM ZK response AAD did not match.");
    const x25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
    const partnerPublic = await crypto.subtle.importKey("raw", toArrayBuffer(base64ToBytes(params.configuration.recipientKey.publicKey)), x25519, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "X25519", public: partnerPublic } as unknown as AlgorithmIdentifier, ephemeral.privateKey, 256);
    const wrappingKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(new Uint8Array(32)), info: new TextEncoder().encode("crm-zk.v1:key-wrap") },
      await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
    const payloadKeyBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(params.response.wrappedKeyIv)), additionalData: toArrayBuffer(aadBytes) },
      wrappingKey, combineCiphertextAndTag(params.response.wrappedPayloadKey, params.response.wrappedKeyTag)
    );
    const payloadKey = await crypto.subtle.importKey("raw", payloadKeyBytes, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(params.response.payloadIv)), additionalData: toArrayBuffer(aadBytes) },
      payloadKey, combineCiphertextAndTag(params.response.ciphertext, params.response.payloadTag)
    );
    const decoded: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("CRM ZK response payload was invalid.");
    return decoded as Record<string, unknown>;
  } finally {
    // A response key is never persisted. A lost session recovers with a fresh
    // bound read; it must never recover by retaining a private key on disk.
    ephemeralKeys.delete(params.context.contextId);
  }
}

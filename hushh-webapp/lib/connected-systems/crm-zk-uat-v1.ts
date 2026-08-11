/** Browser crypto for the isolated, UAT-only `crm-zk-uat.v1` profile. */

import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";

export const CRM_ZK_UAT_V1_PROFILE = "crm-zk-uat.v1" as const;

export type CrmZkUatConfiguration = {
  profile: typeof CRM_ZK_UAT_V1_PROFILE;
  configurationRevision: number;
  recipientKey: { keyId: string; publicKey: string };
  keyDerivation: "SHA-256(X25519 shared secret)";
  aad: false;
};

export type CrmZkUatEncryptedFields = {
  profile: typeof CRM_ZK_UAT_V1_PROFILE;
  direction: "read_request" | "read_response" | "update_request";
  recipientKeyId: string;
  clientOperationId: string;
  expiresAtMs: number;
  clientPublicKey: string;
  wrappedPayloadKey: string;
  wrappedKeyIv: string;
  wrappedKeyTag: string;
  payloadIv: string;
  payloadTag: string;
  ciphertext: string;
};

type EphemeralKey = { privateKey: CryptoKey; publicKey: string; expiresAtMs: number };
const ephemeralKeys = new Map<string, EphemeralKey>();

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function splitGcm(value: ArrayBuffer): { ciphertext: Uint8Array; tag: Uint8Array } {
  const bytes = new Uint8Array(value);
  if (bytes.length < 17) throw new Error("Encrypted CRM output was invalid.");
  return { ciphertext: bytes.slice(0, -16), tag: bytes.slice(-16) };
}

function joinGcm(ciphertext: string, tag: string): ArrayBuffer {
  const left = base64ToBytes(ciphertext);
  const right = base64ToBytes(tag);
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return arrayBuffer(joined);
}

async function wrappingKey(sharedSecret: ArrayBuffer): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", sharedSecret);
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function createCrmZkUatEnvelope(params: {
  configuration: CrmZkUatConfiguration;
  direction: "read_request" | "update_request";
  payload: { searchFields: Record<string, string> } | { additionalFields: Record<string, string> };
}): Promise<CrmZkUatEncryptedFields> {
  if (params.configuration.profile !== CRM_ZK_UAT_V1_PROFILE) {
    throw new Error("CRM encrypted UAT profile mismatch.");
  }
  const x25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
  let pair: CryptoKeyPair;
  try {
    pair = await crypto.subtle.generateKey(x25519, true, ["deriveBits"]) as CryptoKeyPair;
  } catch {
    throw new Error("This device does not support the required CRM encryption.");
  }
  const partnerPublicKey = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(base64ToBytes(params.configuration.recipientKey.publicKey)),
    x25519,
    false,
    [],
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "X25519", public: partnerPublicKey } as unknown as AlgorithmIdentifier,
    pair.privateKey,
    256,
  );
  const wrapKey = await wrappingKey(sharedSecret);
  const payloadKeyBytes = randomBytes(32);
  const payloadKey = await crypto.subtle.importKey(
    "raw", arrayBuffer(payloadKeyBytes), { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const wrappedKeyIv = randomBytes(12);
  const payloadIv = randomBytes(12);
  const wrapped = splitGcm(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: arrayBuffer(wrappedKeyIv) }, wrapKey, arrayBuffer(payloadKeyBytes),
  ));
  const encrypted = splitGcm(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: arrayBuffer(payloadIv) },
    payloadKey,
    new TextEncoder().encode(JSON.stringify(params.payload)),
  ));
  const publicKey = bytesToBase64(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  const clientOperationId = `czku_${crypto.randomUUID().replace(/-/g, "")}`;
  const expiresAtMs = Date.now() + 5 * 60 * 1000;
  for (const [operationId, key] of ephemeralKeys) {
    if (key.expiresAtMs <= Date.now()) ephemeralKeys.delete(operationId);
  }
  if (params.direction === "read_request") {
    ephemeralKeys.set(clientOperationId, {
      privateKey: pair.privateKey,
      publicKey,
      expiresAtMs,
    });
  }
  return {
    profile: CRM_ZK_UAT_V1_PROFILE,
    direction: params.direction,
    recipientKeyId: params.configuration.recipientKey.keyId,
    clientOperationId,
    expiresAtMs,
    clientPublicKey: publicKey,
    wrappedPayloadKey: bytesToBase64(wrapped.ciphertext),
    wrappedKeyIv: bytesToBase64(wrappedKeyIv),
    wrappedKeyTag: bytesToBase64(wrapped.tag),
    payloadIv: bytesToBase64(payloadIv),
    payloadTag: bytesToBase64(encrypted.tag),
    ciphertext: bytesToBase64(encrypted.ciphertext),
  };
}

export async function decryptCrmZkUatReadResponse(params: {
  configuration: CrmZkUatConfiguration;
  response: CrmZkUatEncryptedFields;
}): Promise<{ returnFields: Record<string, unknown> }> {
  const ephemeral = ephemeralKeys.get(params.response.clientOperationId);
  if (!ephemeral || ephemeral.expiresAtMs <= Date.now()) {
    ephemeralKeys.delete(params.response.clientOperationId);
    throw new Error("This CRM response expired. Start a fresh encrypted read.");
  }
  try {
    if (
      params.response.profile !== CRM_ZK_UAT_V1_PROFILE ||
      params.response.direction !== "read_response" ||
      params.response.recipientKeyId !== params.configuration.recipientKey.keyId ||
      params.response.clientPublicKey !== ephemeral.publicKey ||
      params.response.expiresAtMs <= Date.now()
    ) throw new Error("Encrypted CRM response metadata did not match the request.");
    const x25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
    const partnerPublicKey = await crypto.subtle.importKey(
      "raw",
      arrayBuffer(base64ToBytes(params.configuration.recipientKey.publicKey)),
      x25519,
      false,
      [],
    );
    const sharedSecret = await crypto.subtle.deriveBits(
      { name: "X25519", public: partnerPublicKey } as unknown as AlgorithmIdentifier,
      ephemeral.privateKey,
      256,
    );
    const wrapKey = await wrappingKey(sharedSecret);
    const payloadKeyBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: arrayBuffer(base64ToBytes(params.response.wrappedKeyIv)) },
      wrapKey,
      joinGcm(params.response.wrappedPayloadKey, params.response.wrappedKeyTag),
    );
    const payloadKey = await crypto.subtle.importKey(
      "raw", payloadKeyBytes, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: arrayBuffer(base64ToBytes(params.response.payloadIv)) },
      payloadKey,
      joinGcm(params.response.ciphertext, params.response.payloadTag),
    );
    const decoded: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("Encrypted CRM response payload was invalid.");
    }
    const returnFields = (decoded as { returnFields?: unknown }).returnFields;
    if (!returnFields || typeof returnFields !== "object" || Array.isArray(returnFields)) {
      throw new Error("Encrypted CRM response contained no returnFields.");
    }
    return { returnFields: returnFields as Record<string, unknown> };
  } finally {
    ephemeralKeys.delete(params.response.clientOperationId);
  }
}

export function clearCrmZkUatEphemeralKeys(): void {
  ephemeralKeys.clear();
}

export function discardCrmZkUatEphemeralKey(clientOperationId: string): boolean {
  return ephemeralKeys.delete(clientOperationId);
}

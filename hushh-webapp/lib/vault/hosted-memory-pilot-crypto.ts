/**
 * Client-only pilot envelope primitives. This module never releases a key to
 * the server or starts capture. A later reviewed enrollment must pin the
 * attested runtime public key before using runtime key wrapping.
 */

export const HOSTED_PILOT_SOURCE_KIND = "curated_oauth_connector" as const;
export const HOSTED_PILOT_SOURCE_SCOPE = "connector_status.v1" as const;
export const HOSTED_PILOT_ENVELOPE_VERSION = "aes256gcm.pilot.v1" as const;

type PilotContext = {
  ownerId: string;
  grantId: string;
  generation: string;
  sourceId: string;
};

export type PilotOwnerWrappedKey = PilotContext & {
  version: "hosted_memory_owner_wrap.v1";
  sourceKind: typeof HOSTED_PILOT_SOURCE_KIND;
  keyId: string;
  saltBase64Url: string;
  nonceBase64Url: string;
  ciphertextBase64Url: string;
};

export type PilotContentKey = PilotContext & {
  sourceKind: typeof HOSTED_PILOT_SOURCE_KIND;
  keyId: string;
  key: CryptoKey;
};

export type PilotConnectorStatus = {
  provider: string;
  status: "not_connected" | "connected" | "verifying" | "needs_reauth" | "revoked" | "error";
  connectedAt: string | null;
  authStyle: "oauth";
};

export type PilotSourceEnvelope = {
  grantId: string;
  expectedGeneration: string;
  sourceKind: typeof HOSTED_PILOT_SOURCE_KIND;
  sourceId: string;
  scope: typeof HOSTED_PILOT_SOURCE_SCOPE;
  expectedRevision: string;
  envelopeVersion: typeof HOSTED_PILOT_ENVELOPE_VERSION;
  keyId: string;
  nonceBase64Url: string;
  ciphertextBase64Url: string;
  aadSha256: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const SOURCE_ID = /^[a-z0-9_][a-z0-9_.:-]{0,127}$/;
const VAULT_KEY = /^[0-9a-f]{64}$/i;
const MAX_INT64 = 9223372036854775807n;

function validateContext(context: PilotContext): void {
  if (!context.ownerId || context.ownerId.length > 128 ||
      !UUID.test(context.grantId) || !DECIMAL.test(context.generation) ||
      !SOURCE_ID.test(context.sourceId) ||
      BigInt(context.generation) < 1n || BigInt(context.generation) > MAX_INT64) {
    throw new Error("Invalid hosted memory pilot context");
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1)
    throw new Error("Invalid pilot envelope encoding");
  const decoded = atob(encoded.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - encoded.length % 4) % 4));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  if (base64Url(bytes) !== encoded) throw new Error("Noncanonical pilot envelope encoding");
  return bytes;
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (!VAULT_KEY.test(hex)) throw new Error("Unlock your vault before preparing hosted memory");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function ownerWrapAad(context: PilotContext, keyId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`hushh-hosted-owner-wrap-v1\n${base64Url(encoder.encode(context.ownerId))}\n${context.grantId}\n${context.generation}\n${HOSTED_PILOT_SOURCE_KIND}\n${context.sourceId}\n${keyId}`);
}

async function ownerWrapKey(vaultKeyHex: string, context: PilotContext, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const raw = hexBytes(vaultKeyHex);
  try {
    const material = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({
      name: "HKDF", hash: "SHA-256", salt,
      info: encoder.encode(`hushh-hosted-owner-wrap-key-v1\n${base64Url(encoder.encode(context.ownerId))}\n${context.grantId}\n${context.generation}\n${HOSTED_PILOT_SOURCE_KIND}\n${context.sourceId}`),
    }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

/** Generate a new scoped DEK and keep only a vault-wrapped recovery copy. */
export async function createPilotContentKey(
  context: PilotContext,
  vaultKeyHex: string,
): Promise<{ contentKey: PilotContentKey; ownerWrapped: PilotOwnerWrappedKey }> {
  validateContext(context);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const keyId = crypto.randomUUID();
  try {
    const wrappingKey = await ownerWrapKey(vaultKeyHex, context, salt);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: ownerWrapAad(context, keyId) },
      wrappingKey, raw,
    );
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    return {
      contentKey: { ...context, sourceKind: HOSTED_PILOT_SOURCE_KIND, keyId, key },
      ownerWrapped: {
        ...context, version: "hosted_memory_owner_wrap.v1",
        sourceKind: HOSTED_PILOT_SOURCE_KIND, keyId,
        saltBase64Url: base64Url(salt), nonceBase64Url: base64Url(nonce),
        ciphertextBase64Url: base64Url(new Uint8Array(ciphertext)),
      },
    };
  } finally {
    raw.fill(0);
  }
}

/** Recover the pilot DEK only in an unlocked owner session. */
export async function recoverPilotContentKey(
  context: PilotContext,
  vaultKeyHex: string,
  wrapped: PilotOwnerWrappedKey,
): Promise<PilotContentKey> {
  validateContext(context);
  if (wrapped.version !== "hosted_memory_owner_wrap.v1" ||
      wrapped.sourceKind !== HOSTED_PILOT_SOURCE_KIND || !UUID.test(wrapped.keyId) ||
      wrapped.ownerId !== context.ownerId || wrapped.grantId !== context.grantId ||
      wrapped.generation !== context.generation || wrapped.sourceId !== context.sourceId)
    throw new Error("Pilot key context changed");
  const salt = decodeBase64Url(wrapped.saltBase64Url);
  const nonce = decodeBase64Url(wrapped.nonceBase64Url);
  const ciphertext = decodeBase64Url(wrapped.ciphertextBase64Url);
  if (salt.length !== 32 || nonce.length !== 12 || ciphertext.length !== 48)
    throw new Error("Invalid pilot key envelope");
  const wrappingKey = await ownerWrapKey(vaultKeyHex, context, salt);
  const raw = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: ownerWrapAad(context, wrapped.keyId) },
    wrappingKey, ciphertext,
  ));
  try {
    if (raw.length !== 32) throw new Error("Invalid pilot key length");
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    return { ...context, sourceKind: HOSTED_PILOT_SOURCE_KIND, keyId: wrapped.keyId, key };
  } finally {
    raw.fill(0);
  }
}

export function pilotSourceAad(context: PilotContext, sourceId: string, revision: string): Uint8Array<ArrayBuffer> {
  validateContext(context);
  if (sourceId !== context.sourceId || !SOURCE_ID.test(sourceId) || !DECIMAL.test(revision) ||
      BigInt(revision) < 1n || BigInt(revision) > MAX_INT64)
    throw new Error("Invalid pilot source or revision");
  return encoder.encode(`hushh-hosted-source-v1\n${base64Url(encoder.encode(context.ownerId))}\n${context.grantId}\n${context.generation}\n${sourceId}\n${HOSTED_PILOT_SOURCE_SCOPE}\n${revision}`);
}

function validateStatus(sourceId: string, status: PilotConnectorStatus): void {
  if (status.provider !== sourceId || status.authStyle !== "oauth" ||
      !["not_connected", "connected", "verifying", "needs_reauth", "revoked", "error"].includes(status.status) ||
      (status.status === "not_connected" && status.connectedAt !== null) ||
      (status.connectedAt !== null &&
        (typeof status.connectedAt !== "string" || !Number.isFinite(Date.parse(status.connectedAt))))) {
    throw new Error("Connector status outside pilot source scope");
  }
}

function hexDigest(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Seal one allowlisted source value for the owner-only staging route. */
export async function sealPilotConnectorStatus(params: {
  contentKey: PilotContentKey;
  sourceId: string;
  expectedRevision: string;
  status: PilotConnectorStatus;
}): Promise<PilotSourceEnvelope> {
  const { contentKey, sourceId, expectedRevision, status } = params;
  if (contentKey.sourceKind !== HOSTED_PILOT_SOURCE_KIND || !UUID.test(contentKey.keyId) ||
      !DECIMAL.test(expectedRevision) || BigInt(expectedRevision) >= MAX_INT64)
    throw new Error("Invalid pilot source revision");
  validateStatus(sourceId, status);
  const nextRevision = (BigInt(expectedRevision) + 1n).toString();
  const aad = pilotSourceAad(contentKey, sourceId, nextRevision);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({
    scope: HOSTED_PILOT_SOURCE_SCOPE,
    provider: status.provider,
    status: status.status,
    connectedAt: status.connectedAt,
    authStyle: status.authStyle,
  }));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad }, contentKey.key, plaintext,
    );
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", aad));
    return {
      grantId: contentKey.grantId,
      expectedGeneration: contentKey.generation,
      sourceKind: HOSTED_PILOT_SOURCE_KIND,
      sourceId,
      scope: HOSTED_PILOT_SOURCE_SCOPE,
      expectedRevision,
      envelopeVersion: HOSTED_PILOT_ENVELOPE_VERSION,
      keyId: contentKey.keyId,
      nonceBase64Url: base64Url(nonce),
      ciphertextBase64Url: base64Url(new Uint8Array(ciphertext)),
      aadSha256: hexDigest(digest),
    };
  } finally {
    plaintext.fill(0);
  }
}

/** Owner readback and tests verify the exact server revision and AAD. */
export async function openPilotConnectorStatus(params: {
  contentKey: PilotContentKey;
  sourceId: string;
  revision: string;
  nonceBase64Url: string;
  ciphertextBase64Url: string;
}): Promise<PilotConnectorStatus> {
  const { contentKey, sourceId, revision } = params;
  const nonce = decodeBase64Url(params.nonceBase64Url);
  const ciphertext = decodeBase64Url(params.ciphertextBase64Url);
  if (nonce.length !== 12 || ciphertext.length < 17) throw new Error("Invalid pilot source envelope");
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: pilotSourceAad(contentKey, sourceId, revision) },
    contentKey.key, ciphertext,
  ));
  try {
    const value = JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>;
    if (value.scope !== HOSTED_PILOT_SOURCE_SCOPE ||
        Object.keys(value).sort().join(",") !== "authStyle,connectedAt,provider,scope,status")
      throw new Error("Invalid pilot source value");
    const status: PilotConnectorStatus = {
      provider: value.provider as string,
      status: value.status as PilotConnectorStatus["status"],
      connectedAt: value.connectedAt as string | null,
      authStyle: value.authStyle as "oauth",
    };
    validateStatus(sourceId, status);
    return status;
  } finally {
    plaintext.fill(0);
  }
}

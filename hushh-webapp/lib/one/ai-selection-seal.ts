/**
 * Seal a "Bring your own AI" selection to the person's private agent.
 *
 * X25519 with a fresh ephemeral key, HKDF-SHA256 (salt = epk || agent public
 * key, info = "hussh/ai-selection/v1"), then AES-256-GCM over the canonical
 * plaintext with the canonical AAD bytes. Only the agent's private key opens
 * it, so the provider key never reaches Hussh's hub and never rides in a chat
 * request. The recipient must come from the hub-signed pod binding
 * (`ai-selection-recipient.ts`), never from a caller-supplied value.
 */
import { canonicalJson } from "@/lib/services/owner-pod-crypto";
import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";

export const AI_SELECTION_SEAL_ALG = "X25519-HKDF-SHA256-AES256GCM" as const;
const HKDF_INFO = "hussh/ai-selection/v1";
const X25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
/** PKCS#8 wrapper for a raw 32-byte X25519 private key (RFC 8410). */
const X25519_PKCS8_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20];

export type AiSelectionProvider = "openai" | "gemini";
export type AiSelectionTransport = "developer_api" | "vertex_api_key";

export type AiSelectionPlaintext = {
  provider: AiSelectionProvider;
  model: string | null;
  apiKey: string;
  transport: AiSelectionTransport | null;
  vertexProject: string | null;
  vertexLocation: string | null;
};

/** The agent identity from the hub-signed binding. */
export type AiSelectionRecipient = { hushhId: string; podKeyId: string; publicKey: string };

export type AiSelectionAad = {
  purpose: "ai_selection";
  hushhId: string;
  podKeyId: string;
  issuedAtMs: number;
  selectionId: string;
};

export type AiSelectionEnvelope = {
  v: 1;
  alg: typeof AI_SELECTION_SEAL_ALG;
  epk: string;
  iv: string;
  ct: string;
  aad: AiSelectionAad;
};

export class AiSelectionSealError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AiSelectionSealError";
  }
}

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64AnyDecode(value: string): Uint8Array {
  const standard = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
}

function optionalText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new AiSelectionSealError("SELECTION_INVALID");
  }
  return value.trim();
}

/** Exactly the six contract fields, validated; anything else is refused.
 * Limits match the agent's (pod_ai_selection_seal.py), so an oversize value is
 * refused here with a clear reason instead of as a sealed envelope the agent rejects. */
export function normalizeAiSelection(value: unknown): AiSelectionPlaintext {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const provider = input.provider;
  if (provider !== "openai" && provider !== "gemini") throw new AiSelectionSealError("SELECTION_INVALID");
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!apiKey || apiKey.length > 512) throw new AiSelectionSealError("SELECTION_INVALID");
  const transport = input.transport ?? null;
  const transportValid = provider === "openai"
    ? transport === null
    : transport === "developer_api" || transport === "vertex_api_key";
  if (!transportValid) throw new AiSelectionSealError("SELECTION_INVALID");
  const vertexProject = optionalText(input.vertexProject, 64);
  const vertexLocation = optionalText(input.vertexLocation, 64);
  if (transport === "vertex_api_key" && (!vertexProject || !vertexLocation)) {
    throw new AiSelectionSealError("SELECTION_INVALID");
  }
  return {
    provider,
    model: optionalText(input.model, 128),
    apiKey,
    transport: transport as AiSelectionTransport | null,
    vertexProject: transport === "vertex_api_key" ? vertexProject : null,
    vertexLocation: transport === "vertex_api_key" ? vertexLocation : null,
  };
}

function recipientKeyBytes(recipient: AiSelectionRecipient): Uint8Array {
  if (!recipient.hushhId || !recipient.podKeyId) throw new AiSelectionSealError("RECIPIENT_INVALID");
  let raw: Uint8Array;
  try {
    raw = base64AnyDecode(recipient.publicKey);
  } catch {
    throw new AiSelectionSealError("RECIPIENT_INVALID");
  }
  if (raw.length !== 32) throw new AiSelectionSealError("RECIPIENT_INVALID");
  return raw;
}

async function sealWithEphemeral(
  selection: AiSelectionPlaintext,
  recipient: AiSelectionRecipient,
  ephemeral: { privateKey: CryptoKey; publicKeyRaw: Uint8Array },
  iv: Uint8Array,
  aad: AiSelectionAad,
): Promise<AiSelectionEnvelope> {
  if (iv.length !== 12) throw new AiSelectionSealError("IV_INVALID");
  const agentRaw = recipientKeyBytes(recipient);
  const subtle = globalThis.crypto.subtle;
  const agentKey = await subtle.importKey("raw", buf(agentRaw), X25519, false, []);
  const shared = new Uint8Array(await subtle.deriveBits(
    { name: "X25519", public: agentKey } as unknown as AlgorithmIdentifier,
    ephemeral.privateKey,
    256,
  ));
  const salt = new Uint8Array(64);
  salt.set(ephemeral.publicKeyRaw);
  salt.set(agentRaw, 32);
  const hkdf = await subtle.importKey("raw", buf(shared), "HKDF", false, ["deriveKey"]);
  shared.fill(0);
  const aesKey = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(new TextEncoder().encode(HKDF_INFO)) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const plaintext = new TextEncoder().encode(canonicalJson(selection));
  const sealed = new Uint8Array(await subtle.encrypt(
    { name: "AES-GCM", iv: buf(iv), additionalData: buf(new TextEncoder().encode(canonicalJson(aad))), tagLength: 128 },
    aesKey,
    buf(plaintext),
  ));
  plaintext.fill(0);
  return {
    v: 1,
    alg: AI_SELECTION_SEAL_ALG,
    epk: base64UrlEncode(ephemeral.publicKeyRaw),
    iv: base64UrlEncode(iv),
    ct: base64UrlEncode(sealed),
    aad,
  };
}

function aadFor(recipient: AiSelectionRecipient, issuedAtMs: number, selectionId: string): AiSelectionAad {
  if (!Number.isInteger(issuedAtMs) || !selectionId) throw new AiSelectionSealError("AAD_INVALID");
  return { purpose: "ai_selection", hushhId: recipient.hushhId, podKeyId: recipient.podKeyId, issuedAtMs, selectionId };
}

/** Production seal: a fresh non-extractable ephemeral key and random IV per call. */
export async function sealAiSelection(
  selection: AiSelectionPlaintext,
  recipient: AiSelectionRecipient,
  issuedAtMs = Date.now(),
): Promise<AiSelectionEnvelope> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new AiSelectionSealError("DEVICE_UNSUPPORTED");
  let pair: CryptoKeyPair;
  try {
    pair = (await subtle.generateKey(X25519, false, ["deriveBits"])) as CryptoKeyPair;
  } catch {
    throw new AiSelectionSealError("DEVICE_UNSUPPORTED");
  }
  const publicKeyRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = aadFor(recipient, issuedAtMs, globalThis.crypto.randomUUID());
  return sealWithEphemeral(normalizeAiSelection(selection), recipient, { privateKey: pair.privateKey, publicKeyRaw }, iv, aad);
}

/** Deterministic seal for golden vectors: every random input is supplied. */
export async function sealAiSelectionWithFixedInputs(
  selection: AiSelectionPlaintext,
  recipient: AiSelectionRecipient,
  fixed: { ephemeralPrivateKey: Uint8Array; iv: Uint8Array; issuedAtMs: number; selectionId: string },
): Promise<AiSelectionEnvelope> {
  if (fixed.ephemeralPrivateKey.length !== 32) throw new AiSelectionSealError("EPHEMERAL_INVALID");
  const pkcs8 = new Uint8Array(X25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(X25519_PKCS8_PREFIX);
  pkcs8.set(fixed.ephemeralPrivateKey, X25519_PKCS8_PREFIX.length);
  const privateKey = await globalThis.crypto.subtle.importKey("pkcs8", buf(pkcs8), X25519, true, ["deriveBits"]);
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", privateKey);
  const publicKeyRaw = base64AnyDecode(String(jwk.x ?? ""));
  const aad = aadFor(recipient, fixed.issuedAtMs, fixed.selectionId);
  return sealWithEphemeral(normalizeAiSelection(selection), recipient, { privateKey, publicKeyRaw }, fixed.iv, aad);
}

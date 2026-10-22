/**
 * Seal a connector login (a Google authorization code and its PKCE verifier)
 * to the person's private agent.
 *
 * Same envelope as "Bring your own AI" (`ai-selection-seal.ts`) with its own
 * label: X25519 with a fresh ephemeral key, HKDF-SHA256 (salt = epk || agent
 * public key, info = "hussh/connector-credential/v1"), then AES-256-GCM over
 * the canonical plaintext with the canonical AAD bytes. Only the agent's
 * private key opens it, and the agent redeems the code with Google itself, so
 * the code, the token and everything the connector later reads never reach
 * Hussh's hub. The recipient must come from the hub-signed pod binding
 * (`agentRecipientFromBinding`), never from a caller-supplied value.
 *
 * Mirrors `consent-protocol/hushh_mcp/services/pod_connector_credential_seal.py`;
 * `consent-protocol/tests/fixtures/connector_credential_seal_vector_v1.json` is
 * the golden vector both ends assert.
 */
import { canonicalJson } from "@/lib/services/owner-pod-crypto";
import { agentRecipientFromBinding, type AiSelectionSealContext } from "./ai-selection-recipient";
import { base64AnyDecode, base64UrlEncode, type AiSelectionRecipient } from "./ai-selection-seal";

export const CONNECTOR_SEAL_ALG = "X25519-HKDF-SHA256-AES256GCM" as const;
const HKDF_INFO = "hussh/connector-credential/v1";
const X25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
/** PKCS#8 wrapper for a raw 32-byte X25519 private key (RFC 8410). */
const X25519_PKCS8_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20];

export const GOOGLE_CONNECTORS = ["gmail", "calendar", "drive", "contacts"] as const;
export type GoogleConnector = (typeof GOOGLE_CONNECTORS)[number];
export type ConnectorProvider = "google" | "mcp";
export type GoogleClientProfile = "hussh_ios" | "hussh_android" | "owner_client";

export type AuthorizationCodePlaintext = {
  kind: "authorization_code";
  clientProfile: GoogleClientProfile;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
};
export type OwnerClientPlaintext = { kind: "owner_client"; clientId: string; clientSecret: string };
export type McpOauthPlaintext = {
  kind: "mcp_oauth";
  endpoint: string;
  issuer: string;
  tokens: Record<string, unknown>;
  clientInfo: Record<string, unknown>;
};
export type ConnectorCredentialPlaintext = AuthorizationCodePlaintext | OwnerClientPlaintext | McpOauthPlaintext;

/** Opaque hub receipt; it contains no Google authorization material. */
export type GoogleConnectorTransition = { id: string; nonce: string };

export function googleConnectorTransition(value: unknown): GoogleConnectorTransition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorSealError('GOOGLE_TRANSITION_INVALID');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || typeof record.id !== 'string' ||
      !/^gct_[a-f0-9]{32}$/.test(record.id) || typeof record.nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.nonce)) throw new ConnectorSealError('GOOGLE_TRANSITION_INVALID');
  return { id: record.id, nonce: record.nonce };
}

export type ConnectorCredentialAad = {
  purpose: "connector_credential";
  hushhId: string;
  podKeyId: string;
  issuedAtMs: number;
  credentialId: string;
  connectorId: string;
  provider: ConnectorProvider;
};

export type ConnectorCredentialEnvelope = {
  v: 1;
  alg: typeof CONNECTOR_SEAL_ALG;
  epk: string;
  iv: string;
  ct: string;
  aad: ConnectorCredentialAad;
};

export class ConnectorSealError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ConnectorSealError";
  }
}

const GOOGLE_CLIENT_RE = /^[0-9]{4,32}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CONNECTOR_ID_RE = /^(gmail|calendar|drive|contacts|google_owner_client|mcp_[a-z0-9_-]{1,60})$/;

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The kind each connector carries, matching the agent's `expected_kind`. */
export function connectorTarget(connectorId: string): { provider: ConnectorProvider; kind: ConnectorCredentialPlaintext["kind"] } {
  if (!CONNECTOR_ID_RE.test(connectorId)) throw new ConnectorSealError("CONNECTOR_UNSUPPORTED");
  if (connectorId.startsWith("mcp_")) return { provider: "mcp", kind: "mcp_oauth" };
  if (connectorId === "google_owner_client") return { provider: "google", kind: "owner_client" };
  return { provider: "google", kind: "authorization_code" };
}

/** Refuse a plaintext the agent would refuse, so the person gets a clear reason here. */
export function assertConnectorPlaintext(connectorId: string, value: ConnectorCredentialPlaintext): void {
  if (connectorTarget(connectorId).kind !== value.kind) throw new ConnectorSealError("CREDENTIAL_KIND_UNSUPPORTED");
  if (value.kind === "authorization_code") {
    const valid = GOOGLE_CLIENT_RE.test(value.clientId) && VERIFIER_RE.test(value.codeVerifier) &&
      Boolean(value.code) && !/\s/.test(value.code) && value.scopes.length > 0;
    if (!valid) throw new ConnectorSealError("CREDENTIAL_INVALID");
  }
  if (value.kind === "owner_client" && (!GOOGLE_CLIENT_RE.test(value.clientId) || !value.clientSecret)) {
    throw new ConnectorSealError("CREDENTIAL_INVALID");
  }
}

function recipientKeyBytes(recipient: AiSelectionRecipient): Uint8Array {
  if (!recipient.hushhId || !recipient.podKeyId) throw new ConnectorSealError("RECIPIENT_INVALID");
  let raw: Uint8Array;
  try {
    raw = base64AnyDecode(recipient.publicKey);
  } catch {
    throw new ConnectorSealError("RECIPIENT_INVALID");
  }
  if (raw.length !== 32) throw new ConnectorSealError("RECIPIENT_INVALID");
  return raw;
}

async function sealWithEphemeral(
  plaintext: ConnectorCredentialPlaintext,
  recipient: AiSelectionRecipient,
  ephemeral: { privateKey: CryptoKey; publicKeyRaw: Uint8Array },
  iv: Uint8Array,
  aad: ConnectorCredentialAad,
): Promise<ConnectorCredentialEnvelope> {
  if (iv.length !== 12) throw new ConnectorSealError("IV_INVALID");
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
  const body = new TextEncoder().encode(canonicalJson(plaintext));
  const sealed = new Uint8Array(await subtle.encrypt(
    { name: "AES-GCM", iv: buf(iv), additionalData: buf(new TextEncoder().encode(canonicalJson(aad))), tagLength: 128 },
    aesKey,
    buf(body),
  ));
  body.fill(0);
  return {
    v: 1,
    alg: CONNECTOR_SEAL_ALG,
    epk: base64UrlEncode(ephemeral.publicKeyRaw),
    iv: base64UrlEncode(iv),
    ct: base64UrlEncode(sealed),
    aad,
  };
}

function aadFor(recipient: AiSelectionRecipient, connectorId: string, issuedAtMs: number, credentialId: string): ConnectorCredentialAad {
  if (!Number.isInteger(issuedAtMs) || !credentialId) throw new ConnectorSealError("AAD_INVALID");
  const { provider } = connectorTarget(connectorId);
  return {
    purpose: "connector_credential",
    hushhId: recipient.hushhId,
    podKeyId: recipient.podKeyId,
    issuedAtMs,
    credentialId,
    connectorId,
    provider,
  };
}

/** Production seal: a fresh non-extractable ephemeral key and random IV per call. */
export async function sealConnectorCredential(
  connectorId: string,
  plaintext: ConnectorCredentialPlaintext,
  recipient: AiSelectionRecipient,
  issuedAtMs = Date.now(),
): Promise<ConnectorCredentialEnvelope> {
  assertConnectorPlaintext(connectorId, plaintext);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new ConnectorSealError("DEVICE_UNSUPPORTED");
  let pair: CryptoKeyPair;
  try {
    pair = (await subtle.generateKey(X25519, false, ["deriveBits"])) as CryptoKeyPair;
  } catch {
    throw new ConnectorSealError("DEVICE_UNSUPPORTED");
  }
  const publicKeyRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = aadFor(recipient, connectorId, issuedAtMs, globalThis.crypto.randomUUID());
  return sealWithEphemeral(plaintext, recipient, { privateKey: pair.privateKey, publicKeyRaw }, iv, aad);
}

/** Deterministic seal for golden vectors: every random input is supplied. */
export async function sealConnectorCredentialWithFixedInputs(
  connectorId: string,
  plaintext: ConnectorCredentialPlaintext,
  recipient: AiSelectionRecipient,
  fixed: { ephemeralPrivateKey: Uint8Array; iv: Uint8Array; issuedAtMs: number; credentialId: string },
): Promise<ConnectorCredentialEnvelope> {
  if (fixed.ephemeralPrivateKey.length !== 32) throw new ConnectorSealError("EPHEMERAL_INVALID");
  const pkcs8 = new Uint8Array(X25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(X25519_PKCS8_PREFIX);
  pkcs8.set(fixed.ephemeralPrivateKey, X25519_PKCS8_PREFIX.length);
  const privateKey = await globalThis.crypto.subtle.importKey("pkcs8", buf(pkcs8), X25519, true, ["deriveBits"]);
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", privateKey);
  const publicKeyRaw = base64AnyDecode(String(jwk.x ?? ""));
  const aad = aadFor(recipient, connectorId, fixed.issuedAtMs, fixed.credentialId);
  return sealWithEphemeral(plaintext, recipient, { privateKey, publicKeyRaw }, fixed.iv, aad);
}

/**
 * Replace a plaintext connector login body with its sealed envelope for
 * exactly the pod this request is addressed to (the hub-signed binding).
 * Called by the owner-direct transport, so plaintext never leaves the device.
 */
export async function sealConnectorCredentialRequestBody(
  body: string,
  connectorId: string,
  context: AiSelectionSealContext,
): Promise<string> {
  const now = (context.transport.now ?? Date.now)();
  if (context.endpoint.verificationVersion !== 1 || context.session.role !== 'app' ||
      !context.session.scopes.includes('pod.config') || context.session.expiresAt <= now ||
      !context.session.subjectId) throw new ConnectorSealError('OWNER_SESSION_REQUIRED');
  const request = JSON.parse(body) as ConnectorCredentialPlaintext & { transition?: unknown };
  const { transition: suppliedTransition, ...credential } = request;
  const plaintext = credential as ConnectorCredentialPlaintext;
  assertConnectorPlaintext(connectorId, plaintext);
  const transition = suppliedTransition === undefined ? undefined : googleConnectorTransition(suppliedTransition);
  if (transition && (plaintext.kind !== 'authorization_code' ||
      !['hussh_ios', 'hussh_android'].includes(plaintext.clientProfile))) throw new ConnectorSealError('GOOGLE_TRANSITION_INVALID');
  const recipient = await agentRecipientFromBinding(context, { requiredScope: 'pod.config', ownerCloudOnly: true });
  const envelope = await sealConnectorCredential(connectorId, plaintext, recipient, now);
  return JSON.stringify(transition ? { envelope, transition } : envelope);
}

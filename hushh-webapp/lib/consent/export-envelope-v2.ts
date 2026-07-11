import { base64ToBytes } from "@/lib/vault/base64";

export const CONSENT_EXPORT_ENVELOPE_VERSION = 2 as const;
export const CONSENT_EXPORT_PAYLOAD_ALGORITHM = "AES-256-GCM" as const;

export type ConsentExportAadV2 = {
  version: 2;
  app_id: string;
  grant_id: string;
  export_id: string;
  revision: number;
  machine_scope: string;
  scope_handle: string;
  recipient_key_fingerprint: string;
  payload_algorithm: typeof CONSENT_EXPORT_PAYLOAD_ALGORITHM;
  expires_at_ms: number;
};

export type ConsentExportEnvelopeSubmissionV2 = {
  version: 2;
  export_id: string;
  aad: ConsentExportAadV2;
  aad_sha256: string;
  ciphertext_sha256: string;
  ciphertext_bytes: number;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

export function canonicalConsentExportJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function canonicalConsentExportAad(aad: ConsentExportAadV2): string {
  return canonicalConsentExportJson(aad);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)));
  return `sha256:${bytesToHex(digest)}`;
}

export async function sha256ConsentExportBytes(bytes: Uint8Array): Promise<string> {
  return sha256(bytes);
}

export async function connectorKeyFingerprint(connectorPublicKey: string): Promise<string> {
  const raw = base64ToBytes(connectorPublicKey);
  if (raw.byteLength !== 32) {
    throw new Error("Connector public key must be a 32-byte X25519 key.");
  }
  return sha256(raw);
}

export async function buildConsentExportAadV2(params: {
  appId: string;
  grantId: string;
  machineScope: string;
  scopeHandle: string;
  connectorPublicKey: string;
  expiresAtMs: number;
  revision?: number;
  exportId?: string;
}): Promise<ConsentExportAadV2> {
  if (!params.appId || !params.grantId || !params.machineScope || !params.scopeHandle) {
    throw new Error("Consent export identity metadata is incomplete.");
  }
  return {
    version: CONSENT_EXPORT_ENVELOPE_VERSION,
    app_id: params.appId,
    grant_id: params.grantId,
    export_id: params.exportId || crypto.randomUUID(),
    revision: params.revision || 1,
    machine_scope: params.machineScope,
    scope_handle: params.scopeHandle,
    recipient_key_fingerprint: await connectorKeyFingerprint(params.connectorPublicKey),
    payload_algorithm: CONSENT_EXPORT_PAYLOAD_ALGORITHM,
    expires_at_ms: params.expiresAtMs,
  };
}

export async function buildConsentExportEnvelopeSubmissionV2(params: {
  aad: ConsentExportAadV2;
  ciphertextBase64: string;
}): Promise<ConsentExportEnvelopeSubmissionV2> {
  const aadBytes = new TextEncoder().encode(canonicalConsentExportAad(params.aad));
  const ciphertextBytes = base64ToBytes(params.ciphertextBase64);
  if (ciphertextBytes.byteLength === 0) {
    throw new Error("Consent export ciphertext cannot be empty.");
  }
  return {
    version: CONSENT_EXPORT_ENVELOPE_VERSION,
    export_id: params.aad.export_id,
    aad: params.aad,
    aad_sha256: await sha256(aadBytes),
    ciphertext_sha256: await sha256(ciphertextBytes),
    ciphertext_bytes: ciphertextBytes.byteLength,
  };
}

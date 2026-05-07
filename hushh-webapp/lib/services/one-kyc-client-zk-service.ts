"use client";

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import type { PkmWriteCoordinatorResult } from "@/lib/services/pkm-write-coordinator";
import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";
import { OneKycService } from "@/lib/services/one-kyc-service";
import { bytesToBase64 } from "@/lib/vault/base64";

export const KYC_CONNECTOR_PKM_DOMAIN = "kyc_connector" as const;
export const KYC_CONNECTOR_WRAPPING_ALG = "X25519-AES256-GCM" as const;

export type KycClientConnectorPrivateRecord = {
  connector_key_id: string;
  connector_public_key: string;
  connector_private_key: string;
  connector_private_key_format: "pkcs8";
  connector_wrapping_alg: typeof KYC_CONNECTOR_WRAPPING_ALG;
  public_key_fingerprint: string;
  created_at: string;
};

export type KycScopedExportPackage = {
  status?: string;
  encrypted_data: string;
  iv: string;
  tag: string;
  wrapped_key_bundle: {
    wrapped_export_key: string;
    wrapped_key_iv: string;
    wrapped_key_tag: string;
    sender_public_key: string;
    wrapping_alg?: string;
    connector_key_id?: string;
  };
  scope?: string;
  export_revision?: number;
  export_generated_at?: string;
  export_refresh_status?: string;
};

export type KycDraftBuildResult = {
  subject: string;
  body: string;
  approvedValues: Record<string, string>;
  missingFields: string[];
  draftHash: string;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64ToBytesCompat(value: string | undefined | null): Uint8Array {
  if (!value) return new Uint8Array();
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Bytes(value: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    value instanceof Uint8Array ? toArrayBuffer(value) : value
  );
  return new Uint8Array(digest);
}

function normalizeFieldKey(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function truncate(value: unknown, limit = 500): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, limit) : null;
}

function formatApprovedValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return truncate(value);
  }
  if (Array.isArray(value)) {
    return truncate(value.map((item) => formatApprovedValue(item)).filter(Boolean).join(", "));
  }
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "__export_metadata")
      .map(([key, item]) => {
        const formatted = formatApprovedValue(item);
        return formatted ? `${key.replaceAll("_", " ")}: ${formatted}` : null;
      })
      .filter(Boolean);
    return truncate(parts.join("; "), 1000);
  }
  return null;
}

function findApprovedValue(value: unknown, aliases: string[]): string | null {
  const normalizedAliases = new Set(aliases.map(normalizeFieldKey));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "__export_metadata") continue;
      if (normalizedAliases.has(normalizeFieldKey(key))) {
        const formatted = formatApprovedValue(item);
        if (formatted) return formatted;
      }
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "__export_metadata") continue;
      const nested = findApprovedValue(item, aliases);
      if (nested) return nested;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findApprovedValue(item, aliases);
      if (nested) return nested;
    }
  }
  return null;
}

function extractApprovedValues(params: {
  payload: Record<string, unknown>;
  requiredFields: string[];
}): { approvedValues: Record<string, string>; missingFields: string[] } {
  const aliases: Record<string, string[]> = {
    full_name: ["full_name", "fullName", "legal_name", "legalName", "name", "display_name"],
    date_of_birth: ["date_of_birth", "dateOfBirth", "dob", "birth_date", "birthDate"],
    address: ["address", "residential_address", "residentialAddress", "mailing_address"],
    phone_number: ["phone_number", "phoneNumber", "phone", "mobile", "telephone"],
    email: ["email", "email_address", "emailAddress"],
    tax_residency: ["tax_residency", "taxResidency", "tax_residence", "taxResidence"],
    nationality: ["nationality", "citizenship"],
    employment: ["employment", "occupation", "employer"],
    source_of_funds: ["source_of_funds", "sourceOfFunds", "source_of_wealth"],
    brokerage_profile: ["brokerage_profile", "brokerageProfile", "trading_experience"],
    identity_profile: ["identity", "profile", "identity_profile", "identityProfile"],
  };
  const source =
    params.payload.identity && typeof params.payload.identity === "object"
      ? (params.payload.identity as Record<string, unknown>)
      : params.payload;
  const approvedValues: Record<string, string> = {};
  const missingFields: string[] = [];
  for (const field of params.requiredFields.length ? params.requiredFields : ["identity_profile"]) {
    const value = findApprovedValue(source, aliases[field] || [field]);
    if (value) approvedValues[field] = value;
    else missingFields.push(field);
  }
  return { approvedValues, missingFields };
}

function replySubject(subject: string | null | undefined): string {
  const value = String(subject || "KYC request").trim();
  return value.toLowerCase().startsWith("re:") ? value.slice(0, 500) : `Re: ${value}`.slice(0, 500);
}

function kycX25519UnsupportedError(): Error {
  return new Error(
    "One Email KYC requires WebCrypto X25519 support. Use iOS 17 or later for direct device testing."
  );
}

async function generateConnectorRecord(): Promise<KycClientConnectorPrivateRecord> {
  const algorithm = { name: "X25519" } as unknown as AlgorithmIdentifier;
  let keyPair: CryptoKeyPair;
  try {
    keyPair = (await crypto.subtle.generateKey(algorithm, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
  } catch {
    throw kycX25519UnsupportedError();
  }
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const publicKey = bytesToBase64(publicKeyBytes);
  const privateKey = bytesToBase64(privateKeyBytes);
  const fingerprint = await sha256Hex(publicKey);
  return {
    connector_key_id: `one-kyc-${fingerprint.slice(0, 20)}`,
    connector_public_key: publicKey,
    connector_private_key: privateKey,
    connector_private_key_format: "pkcs8",
    connector_wrapping_alg: KYC_CONNECTOR_WRAPPING_ALG,
    public_key_fingerprint: fingerprint,
    created_at: new Date().toISOString(),
  };
}

function parseStoredConnector(value: unknown): KycClientConnectorPrivateRecord | null {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const active = record?.active && typeof record.active === "object"
    ? (record.active as Record<string, unknown>)
    : null;
  if (!active) return null;
  const connector = {
    connector_key_id: String(active.connector_key_id || ""),
    connector_public_key: String(active.connector_public_key || ""),
    connector_private_key: String(active.connector_private_key || ""),
    connector_private_key_format: String(active.connector_private_key_format || ""),
    connector_wrapping_alg: String(active.connector_wrapping_alg || ""),
    public_key_fingerprint: String(active.public_key_fingerprint || ""),
    created_at: String(active.created_at || ""),
  };
  if (
    connector.connector_key_id &&
    connector.connector_public_key &&
    connector.connector_private_key &&
    connector.connector_private_key_format === "pkcs8" &&
    connector.connector_wrapping_alg === KYC_CONNECTOR_WRAPPING_ALG
  ) {
    return connector as KycClientConnectorPrivateRecord;
  }
  return null;
}

export class OneKycClientZkService {
  static async readStoredConnector(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<KycClientConnectorPrivateRecord | null> {
    const snapshot = await PkmDomainResourceService.getStaleFirst({
      userId: params.userId,
      domain: KYC_CONNECTOR_PKM_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      backgroundRefresh: false,
    }).catch(() => null);
    return parseStoredConnector(snapshot?.data);
  }

  static async storeConnector(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    connector: KycClientConnectorPrivateRecord;
  }): Promise<PkmWriteCoordinatorResult> {
    return PkmWriteCoordinator.saveMergedDomain({
      userId: params.userId,
      domain: KYC_CONNECTOR_PKM_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      build: () => ({
        domainData: {
          active: params.connector,
          schema_version: 1,
          updated_at: new Date().toISOString(),
        },
        summary: {
          connector_key_id: params.connector.connector_key_id,
          connector_wrapping_alg: params.connector.connector_wrapping_alg,
          public_key_fingerprint: params.connector.public_key_fingerprint,
          updated_at: new Date().toISOString(),
        },
      }),
    });
  }

  static async ensureConnector(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<KycClientConnectorPrivateRecord> {
    const [stored, backend] = await Promise.all([
      this.readStoredConnector(params),
      OneKycService.getClientConnector({
        userId: params.userId,
        vaultOwnerToken: params.vaultOwnerToken,
      }).catch(() => null),
    ]);
    const backendKeyId = backend?.connector?.connector_key_id || null;
    if (stored && (!backendKeyId || backendKeyId === stored.connector_key_id)) {
      await OneKycService.registerClientConnector({
        userId: params.userId,
        vaultOwnerToken: params.vaultOwnerToken,
        connector: stored,
      });
      return stored;
    }
    const next = await generateConnectorRecord();
    const save = await this.storeConnector({ ...params, connector: next });
    if (!save.success) {
      throw new Error(save.message || "Unable to save KYC connector in your vault.");
    }
    await OneKycService.registerClientConnector({
      userId: params.userId,
      vaultOwnerToken: params.vaultOwnerToken,
      connector: next,
    });
    return next;
  }

  static async decryptScopedExport(params: {
    exportPackage: KycScopedExportPackage;
    connector: KycClientConnectorPrivateRecord;
  }): Promise<Record<string, unknown>> {
    const wrapped = params.exportPackage.wrapped_key_bundle;
    const wrappingAlg = wrapped.wrapping_alg || KYC_CONNECTOR_WRAPPING_ALG;
    if (wrappingAlg !== KYC_CONNECTOR_WRAPPING_ALG) {
      throw new Error("Unsupported KYC export wrapping algorithm.");
    }
    if (wrapped.connector_key_id && wrapped.connector_key_id !== params.connector.connector_key_id) {
      throw new Error("KYC export was wrapped to a different client connector.");
    }

    const x25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
    let sharedSecret: ArrayBuffer;
    try {
      const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        toArrayBuffer(base64ToBytesCompat(params.connector.connector_private_key)),
        x25519,
        false,
        ["deriveBits"]
      );
      const senderPublicKey = await crypto.subtle.importKey(
        "raw",
        toArrayBuffer(base64ToBytesCompat(wrapped.sender_public_key)),
        x25519,
        false,
        []
      );
      sharedSecret = await crypto.subtle.deriveBits(
        { name: "X25519", public: senderPublicKey } as unknown as AlgorithmIdentifier,
        privateKey,
        256
      );
    } catch {
      throw kycX25519UnsupportedError();
    }
    const wrappingKeyBytes = await sha256Bytes(sharedSecret);
    const wrappingKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(wrappingKeyBytes),
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const exportKeyBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToBytesCompat(wrapped.wrapped_key_iv)) },
      wrappingKey,
      toArrayBuffer(
        concatBytes(
          base64ToBytesCompat(wrapped.wrapped_export_key),
          base64ToBytesCompat(wrapped.wrapped_key_tag)
        )
      )
    );
    const exportKey = await crypto.subtle.importKey(
      "raw",
      exportKeyBytes,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToBytesCompat(params.exportPackage.iv)) },
      exportKey,
      toArrayBuffer(
        concatBytes(
          base64ToBytesCompat(params.exportPackage.encrypted_data),
          base64ToBytesCompat(params.exportPackage.tag)
        )
      )
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("KYC export payload is invalid.");
    }
    return parsed as Record<string, unknown>;
  }

  static async buildDraft(params: {
    workflow: OneKycWorkflow;
    exportPayload: Record<string, unknown>;
    instructions?: string;
  }): Promise<KycDraftBuildResult> {
    const { approvedValues, missingFields } = extractApprovedValues({
      payload: params.exportPayload,
      requiredFields: params.workflow.required_fields,
    });
    const counterparty = params.workflow.counterparty_label || "there";
    const fieldLines = Object.entries(approvedValues)
      .map(([field, value]) => `- ${field.replaceAll("_", " ")}: ${value}`)
      .join("\n");
    const instructionText = params.instructions?.trim()
      ? `\nUser requested adjustment: ${params.instructions.trim()}\n`
      : "";
    const body = `Hi ${counterparty},

I am replying on behalf of the account holder through One.

The user approved a scoped KYC workflow for this request. One prepared the following approved information for your review:
${fieldLines || "- Approved identity export available for review."}
${instructionText}
Please let us know if you need anything else for this KYC review.

Best,
One`.slice(0, 6000);
    return {
      subject: replySubject(params.workflow.subject),
      body,
      approvedValues,
      missingFields,
      draftHash: await sha256Hex(body),
    };
  }
}

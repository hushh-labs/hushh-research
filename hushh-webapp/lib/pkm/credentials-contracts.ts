/** Website login records. These objects belong only inside encrypted PKM. */
export const CREDENTIALS_DOMAIN = "credentials";
export const CREDENTIAL_SCHEMA_VERSION = 1 as const;
export const CREDENTIAL_ID = /^cred_[a-f0-9]{32}$/;
export type CredentialAutonomyPolicy = "autonomous" | "confirm_before_fill" | "vault_only";
export type CredentialSummary = {
  id: string;
  label: string;
  boundOrigins: string[];
  usernameHint: string;
  autonomyPolicy: CredentialAutonomyPolicy;
  revision: number;
  generation: number;
  policyGeneration: number;
  custodyGeneration: number;
};
export type CredentialInput = {
  label: string;
  boundOrigins: string[];
  usernameHint?: string;
  autonomyPolicy?: CredentialAutonomyPolicy;
  username: string;
  password: string;
  totpSecret?: string;
  notes?: string;
};
export type CredentialSecrets = {
  username: string;
  password: string;
  totpSecret?: string;
  notes?: string;
};
export type CredentialAad = {
  purpose: "website_credential_payload";
  ownerId: string;
  credentialId: string;
  revision: number;
  generation: number;
  policyGeneration: number;
  custodyGeneration: number;
  autonomyPolicy: CredentialAutonomyPolicy;
  boundOrigins: string[];
};
export type CredentialCiphertext = {
  iv: string;
  ct: string;
};
export type CredentialPodWrap = {
  v: 1;
  alg: "X25519-HKDF-SHA256-AES256GCM";
  epk: string;
  iv: string;
  ct: string;
  aad: CredentialAad & {
    purpose: "website_credential_payload";
    hushhId: string;
    podKeyId: string;
  };
};
export type CredentialRecord = {
  schemaVersion: 1;
  aad: CredentialAad;
  payload: CredentialCiphertext;
  ownerWrap: CredentialCiphertext;
  podWrap: CredentialPodWrap | null;
};
export type CredentialTombstone = {
  revision: number;
  generation: number;
  policyGeneration: number;
  custodyGeneration: number;
};
export type CredentialsDomain = {
  schemaVersion: 1;
  summary: Record<string, CredentialSummary>;
  secrets: Record<string, CredentialRecord>;
  tombstones: Record<string, CredentialTombstone>;
};
export class CredentialError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CredentialError";
  }
}
export function credentialOrigins(origins: readonly string[]): string[] {
  if (!Array.isArray(origins) || !origins.length || origins.length > 16)
    throw new CredentialError("CREDENTIAL_ORIGIN_INVALID");
  const result = origins.map(value => {
    if (typeof value !== "string" || value.length > 2048 || /[\s\\]/.test(value))
      throw new CredentialError("CREDENTIAL_ORIGIN_INVALID");
    let url: URL;
    try {
      url = new URL(value);
    }
    catch {
      throw new CredentialError("CREDENTIAL_ORIGIN_INVALID");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== "/" || !url.hostname.includes(".") || /[\[\]:*]/.test(url.hostname) ||
      /^(?:\d+\.){3}\d+$/.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) {
      throw new CredentialError("CREDENTIAL_ORIGIN_INVALID");
    }
    return url.origin;
  });
  return [...new Set(result)].sort();
}
export function credentialInput(input: CredentialInput): Required<Pick<CredentialInput, "label" | "boundOrigins" | "usernameHint" | "autonomyPolicy" | "username" | "password">> & Pick<CredentialInput, "totpSecret" | "notes"> {
  const allowed = new Set(["label", "boundOrigins", "usernameHint", "autonomyPolicy", "username", "password", "totpSecret", "notes"]);
  if (!input || Object.keys(input).some(key => !allowed.has(key)) || typeof input.label !== "string" ||
    !input.label.trim() || input.label.length > 128 || typeof input.username !== "string" ||
    !input.username || input.username.length > 1024 || typeof input.password !== "string" || !input.password || input.password.length > 4096 ||
    (input.usernameHint !== undefined && (typeof input.usernameHint !== "string" || input.usernameHint.length > 128)) ||
    (input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 4096)) ||
    (input.totpSecret !== undefined && (typeof input.totpSecret !== "string" || !/^[A-Z2-7]{16,128}$/.test(input.totpSecret))))
    throw new CredentialError("CREDENTIAL_INVALID");
  if (new TextEncoder().encode(JSON.stringify({username:input.username,password:input.password,totpSecret:input.totpSecret,notes:input.notes})).length > 16384) throw new CredentialError("CREDENTIAL_PAYLOAD_TOO_LARGE");
  const autonomyPolicy = input.autonomyPolicy ?? "autonomous";
  if (!["autonomous", "confirm_before_fill", "vault_only"].includes(autonomyPolicy))
    throw new CredentialError("CREDENTIAL_POLICY_INVALID");
  // A hint must never contain either of the secret values being saved.
  const usernameHint = input.usernameHint ?? "";
  if (usernameHint === input.username || usernameHint.includes(input.password) || (input.totpSecret && usernameHint.includes(input.totpSecret)))
    throw new CredentialError("CREDENTIAL_HINT_INVALID");
  if (input.label.includes(input.password) || (input.totpSecret && input.label.includes(input.totpSecret)))
    throw new CredentialError("CREDENTIAL_LABEL_INVALID");
  return {
    ...input, label: input.label.trim(), usernameHint, autonomyPolicy, boundOrigins: credentialOrigins(input.boundOrigins)
  };
}

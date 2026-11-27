/** Per-record keys only. Never exports or seals an owner/domain key to a pod. */
import { canonicalJson } from "@/lib/services/owner-pod-crypto";
import { base64AnyDecode, base64UrlEncode, type AiSelectionRecipient } from "@/lib/one/ai-selection-seal";
import { CredentialError, type CredentialAad, type CredentialCiphertext, type CredentialPodWrap, type CredentialRecord, type CredentialSecrets } from "./credentials-contracts";
const encoder = new TextEncoder();
const bytes = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer;
const encoded = (value: unknown) => encoder.encode(canonicalJson(value));
const keyBytes = (hex: string): Uint8Array => {
  if (!/^[a-fA-F0-9]{64}$/.test(hex))
    throw new CredentialError("CREDENTIAL_OWNER_KEY_INVALID");
  return Uint8Array.from(hex.match(/../g)!, item => Number.parseInt(item, 16));
};
async function aes(raw: Uint8Array, usage: "encrypt" | "decrypt") {
  return crypto.subtle.importKey("raw", bytes(raw), "AES-GCM", false, [usage]);
}
async function encrypt(raw: Uint8Array, plain: Uint8Array, aad: unknown): Promise<CredentialCiphertext> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({
    name: "AES-GCM", iv: bytes(iv), additionalData: bytes(encoded(aad))
  }, await aes(raw, "encrypt"), bytes(plain));
  return {
    iv: base64UrlEncode(iv), ct: base64UrlEncode(new Uint8Array(ct))
  };
}
async function decrypt(raw: Uint8Array, value: CredentialCiphertext, aad: unknown): Promise<Uint8Array> {
  if (Object.keys(value).sort().join(",") !== "ct,iv")
    throw new CredentialError("CREDENTIAL_CIPHERTEXT_INVALID");
  return new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM", iv: bytes(base64AnyDecode(value.iv)), additionalData: bytes(encoded(aad))
  }, await aes(raw, "decrypt"), bytes(base64AnyDecode(value.ct))));
}
async function sealToPod(plaintext: unknown, aad: Record<string, unknown>, recipient: AiSelectionRecipient, info: string): Promise<Omit<CredentialPodWrap, "aad"> & {
  aad: Record<string, unknown>;
}> {
  const publicRaw = base64AnyDecode(recipient.publicKey);
  if (publicRaw.length !== 32 || !recipient.hushhId || !recipient.podKeyId)
    throw new CredentialError("CREDENTIAL_RECIPIENT_INVALID");
  const algorithm = {
    name: "X25519"
  } as unknown as AlgorithmIdentifier;
  const pair = await crypto.subtle.generateKey(algorithm, false, ["deriveBits"]) as CryptoKeyPair;
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicKey = await crypto.subtle.importKey("raw", bytes(publicRaw), algorithm, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({
    name: "X25519", public: publicKey
  } as unknown as AlgorithmIdentifier, pair.privateKey, 256));
  const salt = new Uint8Array(64);
  salt.set(epk);
  salt.set(publicRaw, 32);
  const material = await crypto.subtle.importKey("raw", bytes(shared), "HKDF", false, ["deriveBits"]);
  shared.fill(0);
  const wrapping = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt: bytes(salt), info: bytes(encoder.encode(info))
  }, material, 256));
  const wrapAad = {
    ...aad, hushhId: recipient.hushhId, podKeyId: recipient.podKeyId
  };
  const body = encoded(plaintext);
  try {
    return {
      v: 1, alg: "X25519-HKDF-SHA256-AES256GCM", epk: base64UrlEncode(epk), ...await encrypt(wrapping, body, wrapAad), aad: wrapAad
    };
  }
  finally {
    wrapping.fill(0);
    body.fill(0);
  }
}
export async function encryptCredentialRecord(secrets: CredentialSecrets, vaultKey: string, aad: CredentialAad, recipient?: AiSelectionRecipient): Promise<CredentialRecord> {
  if ((aad.autonomyPolicy === "vault_only") !== !recipient)
    throw new CredentialError("CREDENTIAL_CUSTODY_POLICY_MISMATCH");
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const ownerKey = keyBytes(vaultKey);
  const body = encoded(secrets);
  if (body.length > 16384) { dataKey.fill(0); ownerKey.fill(0); body.fill(0); throw new CredentialError("CREDENTIAL_PAYLOAD_TOO_LARGE"); }
  try {
    return {
      schemaVersion: 1, aad, payload: await encrypt(dataKey, body, aad), ownerWrap: await encrypt(ownerKey, dataKey, {
        ...aad, purpose: "website_credential_owner_wrap"
      }), podWrap: recipient ? await sealToPod({
        dataKey: base64UrlEncode(dataKey)
      }, aad, recipient, "hussh/website-credential-key/v1") as CredentialPodWrap : null
    };
  }
  finally {
    dataKey.fill(0);
    ownerKey.fill(0);
    body.fill(0);
  }
}
export async function decryptCredentialRecord(record: CredentialRecord, vaultKey: string, expected: CredentialAad): Promise<CredentialSecrets> {
  if (record.schemaVersion !== 1 || canonicalJson(record.aad) !== canonicalJson(expected))
    throw new CredentialError("CREDENTIAL_RECORD_STALE");
  const ownerKey = keyBytes(vaultKey);
  let dataKey: Uint8Array | undefined;
  let body: Uint8Array | undefined;
  try {
    dataKey = await decrypt(ownerKey, record.ownerWrap, {
      ...expected, purpose: "website_credential_owner_wrap"
    });
    if (dataKey.length !== 32)
      throw new CredentialError("CREDENTIAL_KEY_INVALID");
    body = await decrypt(dataKey, record.payload, expected);
    const result = JSON.parse(new TextDecoder().decode(body)) as CredentialSecrets;
    if (!result || typeof result.username !== "string" || typeof result.password !== "string" || Object.keys(result).some(k => !["username", "password", "totpSecret", "notes"].includes(k)))
      throw new CredentialError("CREDENTIAL_PAYLOAD_INVALID");
    return result;
  }
  catch {
    throw new CredentialError("CREDENTIAL_DECRYPT_REFUSED");
  }
  finally {
    ownerKey.fill(0);
    dataKey?.fill(0);
    body?.fill(0);
  }
}
export type CredentialUseAad = {
  purpose: "website_credential_use";
  ownerId: string;
  credentialId: string;
  recordRevision: number;
  policyGeneration: number;
  custodyGeneration: number;
  hushhId: string;
  podKeyId: string;
  taskId: string;
  incarnation: string;
  controlEpoch: number;
  origin: string;
  operationId: string;
  expiresAt: number;
  nonce: string;
};
export async function sealCredentialUsePayload(plaintext: Record<string, unknown>, aad: CredentialUseAad, recipient: AiSelectionRecipient) {
  return sealToPod(plaintext, aad, recipient, "hussh/website-credential-use/v1");
}

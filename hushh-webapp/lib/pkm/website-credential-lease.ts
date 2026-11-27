"use client";

import { canonicalJson } from "@/lib/services/owner-pod-crypto";
import { base64AnyDecode, base64UrlEncode } from "@/lib/one/ai-selection-seal";
import { SecretsVaultService, type SecretsVaultContext } from "./secrets-vault-service";
import { WebsiteCredentialError, type WebsiteCredentialItemV1 } from "./website-credential";

export type BrowserLoginLeaseKey = Readonly<{ id: string; publicKey: string; expiresAt: number }>;
export type BrowserLoginSelection = Readonly<{ recordRevision: number; sourceContentRevision: number; sourceManifestRevision: number; rememberSession: boolean }>;
export type WebsiteCredentialUseAad = {
  purpose: "website_credential_use"; ownerId: string; credentialId: string; recordRevision: number;
  sourceContentRevision: number; sourceManifestRevision: number; podId: string; leaseKeyId: string;
  taskId: string; incarnation: string; controlEpoch: number; origin: string; operationId: string; expiresAt: number; nonce: string;
};
export type WebsiteCredentialLease = { envelope: { v: 1; alg: "X25519-HKDF-SHA256-AES256GCM"; epk: string; iv: string; ct: string; aad: WebsiteCredentialUseAad } };
const buffer = (value: Uint8Array): Uint8Array<ArrayBuffer> => value as Uint8Array<ArrayBuffer>;
const credentialPlaintext = (item: WebsiteCredentialItemV1) => canonicalJson({ username: item.credential.username, password: item.value,
  ...(item.totp_secret ? { totpSecret: item.totp_secret } : {}) });
/** Browser fill is narrower than Secrets storage. This check never changes the saved item. */
export function assertBrowserCredentialFillEligible(item: WebsiteCredentialItemV1): void {
  const encoder = new TextEncoder();
  for (const value of [item.credential.username, item.value]) {
    const bytes = encoder.encode(value);
    try {
      if (bytes.length < 1 || bytes.length > 4096) throw new WebsiteCredentialError("WEBSITE_BROWSER_MANUAL_REQUIRED");
    } finally { bytes.fill(0); }
  }
  if (item.totp_secret !== undefined && !/^[A-Z2-7]{16,128}$/.test(item.totp_secret)) throw new WebsiteCredentialError("WEBSITE_BROWSER_MANUAL_REQUIRED");
  const plain = encoder.encode(credentialPlaintext(item));
  try {
    if (plain.length > 16384) throw new WebsiteCredentialError("WEBSITE_BROWSER_MANUAL_REQUIRED");
  } finally { plain.fill(0); }
}
export function credentialUseExpiry(taskExpiresAt: number, leaseExpiresAt: number, nowMs = Date.now()): number {
  const now = Math.floor(nowMs / 1000);
  if (![taskExpiresAt, leaseExpiresAt].every(value => Number.isSafeInteger(value) && value > now)) throw new WebsiteCredentialError("WEBSITE_LEASE_EXPIRED");
  return Math.min(now + 60, taskExpiresAt, leaseExpiresAt);
}
/** Called only by the fixed host Allow action after its exact review receipt.
 * The recipient is the authenticated task's ephemeral worker key, never a pod key. */
export async function sealTransientCredentialUse(context: SecretsVaultContext, id: string, request: BrowserLoginSelection & {
  operationId: string; taskId: string; taskExpiresAt: number; incarnation: string; controlEpoch: number; origin: string; podId: string; leaseKey: BrowserLoginLeaseKey;
}): Promise<WebsiteCredentialLease> {
  if (!context.beforeEffect) throw new WebsiteCredentialError("WEBSITE_OWNER_GUARD_REQUIRED");
  await context.beforeEffect();
  const expiresAt = credentialUseExpiry(request.taskExpiresAt, request.leaseKey.expiresAt);
  const fresh = await SecretsVaultService.websiteLoginSnapshot(context, id);
  await context.beforeEffect?.();
  const { item } = fresh;
  if (item.revision !== request.recordRevision || fresh.contentRevision !== request.sourceContentRevision || fresh.manifestRevision !== request.sourceManifestRevision ||
    !item.bound_origins.includes(request.origin) || !/^lease_[a-f0-9]{32}$/.test(request.leaseKey.id) || !request.podId || request.podId.length > 256 ||
    !/^browser_[a-f0-9]{32}$/.test(request.taskId) || !request.incarnation || request.incarnation.length > 256 ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(request.operationId) || !Number.isSafeInteger(request.controlEpoch) || request.controlEpoch < 1) throw new WebsiteCredentialError("WEBSITE_LEASE_REFUSED");
  assertBrowserCredentialFillEligible(item);
  const recipient = base64AnyDecode(request.leaseKey.publicKey);
  if (recipient.length !== 32) throw new WebsiteCredentialError("WEBSITE_LEASE_KEY_INVALID");
  const algorithm = { name: "X25519" } as AlgorithmIdentifier;
  const pair = await crypto.subtle.generateKey(algorithm, false, ["deriveBits"]) as CryptoKeyPair;
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicKey = await crypto.subtle.importKey("raw", buffer(recipient), algorithm, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: publicKey } as AlgorithmIdentifier, pair.privateKey, 256));
  let wrapping: Uint8Array | undefined;
  let plain: Uint8Array | undefined;
  try {
    const salt = new Uint8Array(64); salt.set(epk); salt.set(recipient, 32);
    const material = await crypto.subtle.importKey("raw", buffer(shared), "HKDF", false, ["deriveBits"]);
    shared.fill(0);
    wrapping = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buffer(salt), info: buffer(new TextEncoder().encode("hussh/website-credential-use/v1")) }, material, 256));
    const aad: WebsiteCredentialUseAad = { purpose: "website_credential_use", ownerId: context.userId, credentialId: id,
      recordRevision: item.revision, sourceContentRevision: fresh.contentRevision, sourceManifestRevision: fresh.manifestRevision,
      podId: request.podId, leaseKeyId: request.leaseKey.id, taskId: request.taskId, incarnation: request.incarnation,
      controlEpoch: request.controlEpoch, origin: request.origin, operationId: request.operationId, expiresAt, nonce: crypto.randomUUID() };
    plain = new TextEncoder().encode(credentialPlaintext(item));
    if (plain.length > 16384) throw new WebsiteCredentialError("WEBSITE_LEASE_TOO_LARGE");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", buffer(wrapping), "AES-GCM", false, ["encrypt"]);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(iv), additionalData: buffer(new TextEncoder().encode(canonicalJson(aad))) }, key, buffer(plain));
    await context.beforeEffect?.();
    return { envelope: { v: 1, alg: "X25519-HKDF-SHA256-AES256GCM", epk: base64UrlEncode(epk), iv: base64UrlEncode(iv), ct: base64UrlEncode(new Uint8Array(ct)), aad } };
  } finally { shared.fill(0); wrapping?.fill(0); plain?.fill(0); }
}

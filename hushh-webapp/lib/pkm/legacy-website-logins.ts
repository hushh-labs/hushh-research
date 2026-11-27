"use client";

/** Read-only recovery for the superseded encrypted credentials bucket. This
 * module cannot create wraps, grant pod custody, write or delete legacy records. */
import { canonicalJson } from "@/lib/services/owner-pod-crypto";
import { base64AnyDecode } from "@/lib/one/ai-selection-seal";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { websiteLoginInput, WebsiteCredentialError, type WebsiteLoginInput } from "./website-credential";
import type { SecretsVaultContext } from "./secrets-vault-service";

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
const buffer = (value: Uint8Array): Uint8Array<ArrayBuffer> => value as Uint8Array<ArrayBuffer>;
async function decrypt(key: Uint8Array, value: unknown, aad: unknown): Promise<Uint8Array> {
  if (!object(value) || Object.keys(value).sort().join(",") !== "ct,iv" || typeof value.iv !== "string" || typeof value.ct !== "string") throw new WebsiteCredentialError("LEGACY_LOGIN_INVALID");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(base64AnyDecode(value.iv)),
    additionalData: buffer(new TextEncoder().encode(canonicalJson(aad))) },
  await crypto.subtle.importKey("raw", buffer(key), "AES-GCM", false, ["decrypt"]), buffer(base64AnyDecode(value.ct))));
}
export async function readLegacyWebsiteLogins(context: SecretsVaultContext): Promise<readonly { id: string; revision: number; input: WebsiteLoginInput }[]> {
  if (!context.userId || !context.vaultKey || !context.vaultOwnerToken || !context.beforeEffect || !/^[a-fA-F0-9]{64}$/.test(context.vaultKey)) throw new WebsiteCredentialError("LEGACY_LOGIN_LOCKED");
  await context.beforeEffect();
  const { data } = await PersonalKnowledgeModelService.loadDomainSnapshot({ userId: context.userId, vaultKey: context.vaultKey, vaultOwnerToken: context.vaultOwnerToken, domain: "credentials", force: true });
  await context.beforeEffect();
  if (data == null) return [];
  if (!object(data) || !object(data.summary) || !object(data.secrets)) throw new WebsiteCredentialError("LEGACY_LOGIN_INVALID");
  const result: { id: string; revision: number; input: WebsiteLoginInput }[] = [];
  const ownerKey = Uint8Array.from(context.vaultKey.match(/../g)!, part => parseInt(part, 16));
  try {
    for (const [id, summary] of Object.entries(data.summary)) {
      if (object(data.tombstones) && data.tombstones[id]) continue;
      const record = data.secrets[id];
      if (!/^cred_[a-f0-9]{32}$/.test(id) || !object(summary) || !object(record) || !object(record.aad) || record.schemaVersion !== 1 ||
        record.aad.ownerId !== context.userId || record.aad.credentialId !== id || record.aad.revision !== summary.revision || !Number.isSafeInteger(summary.revision)) throw new WebsiteCredentialError("LEGACY_LOGIN_INVALID");
      let key: Uint8Array | undefined; let body: Uint8Array | undefined;
      try {
        key = await decrypt(ownerKey, record.ownerWrap, { ...record.aad, purpose: "website_credential_owner_wrap" });
        if (key.length !== 32) throw new WebsiteCredentialError("LEGACY_LOGIN_INVALID");
        body = await decrypt(key, record.payload, record.aad);
        const secret = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
        const input = websiteLoginInput({ label: summary.label as string, boundOrigins: summary.boundOrigins as string[],
          username: secret.username as string, password: secret.password as string, staySignedInEnabled: false,
          ...(secret.totpSecret ? { totpSecret: secret.totpSecret as string } : {}), ...(secret.notes ? { notes: secret.notes as string } : {}) });
        await context.beforeEffect();
        result.push({ id, revision: summary.revision as number, input });
      } finally { key?.fill(0); body?.fill(0); }
    }
    return result;
  } finally { ownerKey.fill(0); }
}

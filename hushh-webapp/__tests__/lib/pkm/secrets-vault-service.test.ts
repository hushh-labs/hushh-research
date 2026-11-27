// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { decryptCredentialRecord } from "@/lib/pkm/credential-crypto";

const { saveMergedDomain, loadDomainData, loadDomainSnapshot } = vi.hoisted(() => ({
  saveMergedDomain: vi.fn(),
  loadDomainData: vi.fn(),
  loadDomainSnapshot: vi.fn(),
}));

vi.mock("@/lib/services/consent-export-refresh-orchestrator", () => ({ConsentExportRefreshOrchestrator:{ensureRunning:vi.fn(async()=>{})}}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: { saveMergedDomain } }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { loadDomainData, loadDomainSnapshot },
}));

import { planSecretCaptures } from "@/lib/pkm/secret-span-guard";
import { SecretsLockedError, SecretsVaultService } from "@/lib/pkm/secrets-vault-service";
import { CredentialsVaultService, credentialUseExpiry, sealTransientCredentialUse } from "@/lib/pkm/credentials-vault-service";
import { CredentialError } from "@/lib/pkm/credentials-contracts";
import { KycIdentityDocumentsService } from "@/lib/services/kyc-identity-documents-service";
import { decryptData, encryptData, type EncryptedPayload } from "@/lib/vault/encrypt";

/**
 * The reserved `secrets` domain: a value is stored only as vault-key
 * ciphertext, the plaintext beside it (summary and manifest) holds neither the
 * value nor its label, and nothing is decrypted without an unlocked vault.
 */

const VAULT_KEY = "0f".repeat(32);
const API_KEY = ["s", "k-proj-", "fakefake0000fakefake9f2a"].join("");
const CONTEXT = { userId: "user_1", vaultKey: VAULT_KEY, vaultOwnerToken: "owner_token" };

type Sent = { ciphertext: EncryptedPayload; summary: unknown; manifest: unknown; confirmation: unknown };
let stored: EncryptedPayload | null = null;
const sent: Sent[] = [];

beforeEach(() => {
  stored = null;
  sent.length = 0;
  saveMergedDomain.mockReset().mockImplementation(async (params) => {
    await params.beforeEffect?.();
    const currentDomainData = stored ? JSON.parse(await decryptData(stored, VAULT_KEY)) : {};
    const plan = await params.build({ currentDomainData, currentManifest: null, attempt: 0 });
    // What the coordinator does with a plan: encrypt the domain under the vault key.
    stored = await encryptData(JSON.stringify(plan.domainData), VAULT_KEY);
    sent.push({ ciphertext: stored, summary: plan.summary, manifest: plan.manifest, confirmation: params.confirmation });
    return { success: true, saveState: "saved", fullBlob: {}, dataVersion: sent.length };
  });
  loadDomainData.mockReset().mockImplementation(async () =>
    stored ? JSON.parse(await decryptData(stored, VAULT_KEY)) : null);
  loadDomainSnapshot.mockReset().mockImplementation(async () => ({
    snapshot: stored ? { contentRevision: sent.length, manifestRevision: sent.length } : null,
    data: stored ? JSON.parse(await decryptData(stored, VAULT_KEY)) : null,
  }));
});

describe("SecretsVaultService", () => {
  it("preserves read failures and carries owner guards to the existing removal and identity writers", async () => {
    loadDomainData.mockRejectedValueOnce(new Error("read_unavailable"));
    await expect(SecretsVaultService.listSecrets(CONTEXT)).rejects.toThrow("read_unavailable");
    const beforeEffect = vi.fn().mockRejectedValue(new Error("retired"));
    await expect(SecretsVaultService.removeSecret({ ...CONTEXT, secretId: "sec_00000000000000a1", beforeEffect })).rejects.toThrow("retired");
    await expect(KycIdentityDocumentsService.fileDocument({ ...CONTEXT, documentType: "passport", number: "SYNTHETIC_NUMBER", label: "Synthetic", beforeEffect })).rejects.toThrow("retired");
    expect(beforeEffect).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(0);
    const input = { ...CONTEXT, documentType: "passport" as const, number: "SYNTHETIC_NUMBER", label: "First synthetic document", sourceSecretId: "sec_00000000000000a1" };
    await KycIdentityDocumentsService.fileDocument(input);
    await KycIdentityDocumentsService.fileDocument({ ...input, label: "Repeated offer must not overwrite", number: "DIFFERENT_SYNTHETIC_NUMBER" });
    const domain = JSON.parse(await decryptData(stored!, VAULT_KEY));
    expect(Object.keys(domain.identity_documents)).toEqual(["doc_00000000000000a1"]);
    expect(domain.identity_documents.doc_00000000000000a1).toMatchObject({ number: "SYNTHETIC_NUMBER", label: input.label });
  });
  it("round-trips a value as ciphertext, with no value or label in the plaintext envelope", async () => {
    const plan = planSecretCaptures([`openai key ${API_KEY}`]);
    const saved = await SecretsVaultService.saveCaptures({ ...CONTEXT, captures: plan.captures, surface: "chat" });
    expect(saved.ok).toBe(true);

    const [write] = sent;
    expect(write!.confirmation).toEqual({ confirmedByUser: true, surface: "chat", source: "secrets_vault" });
    expect(JSON.stringify(write!.ciphertext)).not.toContain(API_KEY);
    const envelope = JSON.stringify([write!.summary, write!.manifest]);
    expect(envelope).not.toContain(API_KEY);
    expect(envelope).not.toContain("openai API key");
    expect(write!.summary).toMatchObject({ domain_intent: "secrets", item_count: 1, storage_mode: "encrypted_domain" });
    expect(Object.values(write!.summary as Record<string, unknown>).every((value) => typeof value !== "object")).toBe(true);

    const [item] = await SecretsVaultService.listSecrets(CONTEXT);
    expect(item).toMatchObject({ label: "openai API key ending 9f2a", kind: "credential", fileTo: "none" });
    expect(JSON.stringify(item)).not.toContain(API_KEY);
    await expect(SecretsVaultService.revealSecret({ ...CONTEXT, secretId: item!.id })).resolves.toBe(API_KEY);
  });

  it("reuses the stored item when the same value is sent again", async () => {
    const first = planSecretCaptures([`key ${API_KEY}`]);
    await SecretsVaultService.saveCaptures({ ...CONTEXT, captures: first.captures, surface: "chat" });
    const second = planSecretCaptures([`again ${API_KEY}`]);
    const saved = await SecretsVaultService.saveCaptures({ ...CONTEXT, captures: second.captures, surface: "chat" });
    expect(saved.ok && saved.resolved.get(second.captures[0]!.id)?.id).toBe(first.captures[0]!.id);
    expect(await SecretsVaultService.listSecrets(CONTEXT)).toHaveLength(1);
  });

  it("reveals nothing without an unlocked vault (negative control)", async () => {
    const plan = planSecretCaptures([`key ${API_KEY}`]);
    await SecretsVaultService.saveCaptures({ ...CONTEXT, captures: plan.captures, surface: "chat" });
    loadDomainData.mockClear();

    await expect(
      SecretsVaultService.revealSecret({ ...CONTEXT, vaultKey: null, secretId: plan.captures[0]!.id }),
    ).rejects.toBeInstanceOf(SecretsLockedError);
    expect(loadDomainData).not.toHaveBeenCalled();
    await expect(SecretsVaultService.revealSecret({ ...CONTEXT, secretId: plan.captures[0]!.id })).resolves.toBe(API_KEY);
  });

  it("saves nothing, and says so, while the vault is locked", async () => {
    const plan = planSecretCaptures([`key ${API_KEY}`]);
    const saved = await SecretsVaultService.saveCaptures({ ...CONTEXT, vaultKey: null, captures: plan.captures, surface: "chat" });
    expect(saved).toMatchObject({ ok: false, reason: "locked" });
    expect(saveMergedDomain).not.toHaveBeenCalled();
  });
});


describe("Website credentials in the existing encrypted PKM writer", () => {
  const input = {label:"Synthetic account",boundOrigins:["https://example.com"],usernameHint:"ending owner",username:"synthetic-owner",password:"SYNTHETIC_WEBSITE_PASSWORD_123"};
  async function custody() {
    const pair = await crypto.subtle.generateKey({name:"X25519"},false,["deriveBits"]) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw",pair.publicKey));
    return {recipient:{hushhId:"pod",podKeyId:"key",publicKey:Buffer.from(raw).toString("base64")},recheck:vi.fn(async()=>{}),generationFloor:vi.fn(async()=>0),fence:vi.fn(async()=>{}),publish:vi.fn(async()=>{})};
  }
  it("refreshes and reveals authoritative cross-device edits and deletion despite a warm stale cache", async () => {
    const first = await CredentialsVaultService.save(CONTEXT, { ...input, autonomyPolicy: "vault_only" });
    const stale = JSON.parse(await decryptData(stored!, VAULT_KEY));
    loadDomainData.mockResolvedValue(stale);
    loadDomainSnapshot.mockImplementation(async ({ force }) => ({
      snapshot: { contentRevision: force ? sent.length : 1, manifestRevision: force ? sent.length : 1 },
      data: force ? JSON.parse(await decryptData(stored!, VAULT_KEY)) : stale,
    }));
    // A second device commits through the encrypted writer without invalidating
    // this device's still-warm domain cache.
    const changed = await CredentialsVaultService.save(CONTEXT,
      { ...input, label: "Updated on another device", password: "SYNTHETIC_CHANGED_PASSWORD_456", autonomyPolicy: "vault_only" },
      { id: first.id, expectedRevision: first.revision });
    await expect(CredentialsVaultService.list(CONTEXT)).resolves.toMatchObject([
      { id: first.id, label: "Updated on another device", revision: changed.revision },
    ]);
    await expect(CredentialsVaultService.reveal(CONTEXT, first.id)).resolves.toMatchObject({ password: "SYNTHETIC_CHANGED_PASSWORD_456" });
    loadDomainSnapshot.mockRejectedValueOnce(new Error("authority_read_unavailable"));
    await expect(CredentialsVaultService.list(CONTEXT)).rejects.toThrow("authority_read_unavailable");
    await CredentialsVaultService.remove(CONTEXT, first.id, changed.revision);
    await expect(CredentialsVaultService.list(CONTEXT)).resolves.toEqual([]);
    await expect(CredentialsVaultService.reveal(CONTEXT, first.id)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  });
  it("bounds a transient use to its task expiry and refuses expired work before reading secrets", async () => {
    const nowMs = 1_800_000_000_000;
    const now = nowMs / 1000;
    expect(credentialUseExpiry(now + 10, nowMs)).toBe(now + 10);
    expect(credentialUseExpiry(now + 120, nowMs)).toBe(now + 60);
    const clock = vi.spyOn(Date,"now").mockReturnValue(nowMs);
    try {
      await expect(sealTransientCredentialUse(CONTEXT,"cred_"+"a".repeat(32),{operationId:"operation_123",taskId:"task",taskExpiresAt:now,incarnation:"incarnation",controlEpoch:1,origin:"https://example.com",recipient:{hushhId:"pod",podKeyId:"key",publicKey:"unused"}})).rejects.toMatchObject({code:"CREDENTIAL_USE_EXPIRED"});
      expect(loadDomainData).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it("recovers the owner wrap of the shared production TypeScript/Python vector", async () => {
    const vector = JSON.parse(fs.readFileSync(path.resolve(process.cwd(),"..","consent-protocol","tests","fixtures","website_credential_vector_v1.json"),"utf8"));
    await expect(decryptCredentialRecord(vector.record,vector.ownerVaultKeyHex,vector.record.aad)).resolves.toEqual(vector.expectedPayload);
  });
  it("isolates sibling keys, keeps the plaintext envelope empty of metadata, and preserves owner recovery", async () => {
    const port = await custody();
    const first = await CredentialsVaultService.save({...CONTEXT,custody:port},input);
    const second = await CredentialsVaultService.save(CONTEXT,{...input,label:"Vault only",autonomyPolicy:"vault_only"});
    expect(first.autonomyPolicy).toBe("autonomous");
    const data = JSON.parse(await decryptData(stored!,VAULT_KEY));
    expect(data.secrets[first.id].podWrap.aad).toMatchObject({credentialId:first.id,ownerId:CONTEXT.userId,hushhId:"pod",podKeyId:"key"});
    expect(data.secrets[second.id].podWrap).toBeNull();
    expect(data.secrets[first.id].ownerWrap).not.toEqual(data.secrets[second.id].ownerWrap);
    expect(JSON.stringify(data.secrets)).not.toContain(input.password);
    const plaintextIndex = JSON.stringify(sent.map(write=>[write.summary,write.manifest]));
    for (const privateValue of [input.label,input.username,input.password,"https://example.com"]) expect(plaintextIndex).not.toContain(privateValue);
    await expect(CredentialsVaultService.reveal(CONTEXT,first.id)).resolves.toMatchObject({username:input.username,password:input.password});
    data.secrets[second.id].ownerWrap = data.secrets[first.id].ownerWrap;
    stored = await encryptData(JSON.stringify(data),VAULT_KEY);
    await expect(CredentialsVaultService.reveal(CONTEXT,second.id)).rejects.toMatchObject({code:"CREDENTIAL_DECRYPT_REFUSED"});
    expect(port.publish).toHaveBeenCalledWith(first.id,1,expect.any(Number));
  });
  it("fences edits before writing, rotates individual keys, and leaves a deletion tombstone", async () => {
    const port = await custody(); const context = {...CONTEXT,custody:port};
    const first = await CredentialsVaultService.save(context,input);
    const old = JSON.parse(await decryptData(stored!,VAULT_KEY)).secrets[first.id];
    const rotated = await CredentialsVaultService.rotate(context,first.id,first.revision);
    expect(rotated).toMatchObject({revision:2,generation:2,policyGeneration:2,custodyGeneration:2});
    expect(port.fence).toHaveBeenCalledWith(first.id,1);
    expect(JSON.parse(await decryptData(stored!,VAULT_KEY)).secrets[first.id].payload).not.toEqual(old.payload);
    const writes = sent.length;
    await expect(CredentialsVaultService.save(context,input,{id:first.id,expectedRevision:1})).rejects.toMatchObject({code:"CREDENTIAL_REVISION_STALE"});
    expect(sent).toHaveLength(writes);
    port.generationFloor.mockResolvedValueOnce(10);
    const recovered = await CredentialsVaultService.rotate(context,rotated.id,2);
    expect(recovered).toMatchObject({revision:11,generation:11,policyGeneration:11,custodyGeneration:11});
    await CredentialsVaultService.remove(context,recovered.id,11);
    const data = JSON.parse(await decryptData(stored!,VAULT_KEY));
    expect(data.summary).toEqual({}); expect(data.secrets).toEqual({});
    expect(data.tombstones[first.id]).toMatchObject({revision:12,generation:12});
    await expect(CredentialsVaultService.save(context,input,{id:first.id,expectedRevision:2})).rejects.toThrow();
  });
  it("requires custody for autonomous writes and rejects owner retirement, broad origins and a locked vault", async () => {
    await expect(CredentialsVaultService.save(CONTEXT,input)).rejects.toMatchObject({code:"CREDENTIAL_CUSTODY_UNAVAILABLE"});
    await expect(CredentialsVaultService.save(CONTEXT,{...input,autonomyPolicy:"vault_only",boundOrigins:["https://*.example.com"]})).rejects.toMatchObject({code:"CREDENTIAL_ORIGIN_INVALID"});
    await expect(CredentialsVaultService.save({...CONTEXT,vaultKey:null},input)).rejects.toMatchObject({code:"CREDENTIAL_VAULT_LOCKED"});
    await expect(CredentialsVaultService.save({...CONTEXT,beforeEffect:async()=>{throw new CredentialError("OWNER_RETIRED");}},{...input,autonomyPolicy:"vault_only"})).rejects.toMatchObject({code:"OWNER_RETIRED"});
    expect(sent).toHaveLength(0);
    stored = await encryptData(JSON.stringify({schemaVersion:2,summary:{},secrets:{},tombstones:{}}),VAULT_KEY);
    await expect(CredentialsVaultService.save(CONTEXT,{...input,autonomyPolicy:"vault_only"})).rejects.toMatchObject({code:"CREDENTIAL_SCHEMA_UNSUPPORTED"});
    expect(sent).toHaveLength(0);
  });
});

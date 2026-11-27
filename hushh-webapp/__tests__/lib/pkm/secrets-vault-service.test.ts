// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

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
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { ApiService } from "@/lib/services/api-service";
import { prepareCredentialShare, buildSecretItemExport } from "@/lib/services/credential-sharing-service";
import { SecretsLockedError, SecretsVaultService } from "@/lib/pkm/secrets-vault-service";
import { credentialUseExpiry, sealTransientCredentialUse } from "@/lib/pkm/website-credential-lease";
import { parseWebsiteCredentialItem } from "@/lib/pkm/website-credential";
import { canonicalJson } from "@/lib/services/owner-pod-crypto";
import { base64AnyDecode, base64UrlEncode } from "@/lib/one/ai-selection-seal";
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
let testVaultKey = VAULT_KEY;
const sent: Sent[] = [];

beforeEach(() => {
  testVaultKey = VAULT_KEY;
  stored = null;
  sent.length = 0;
  saveMergedDomain.mockReset().mockImplementation(async (params) => {
    await params.beforeEffect?.();
    const currentDomainData = stored ? JSON.parse(await decryptData(stored, testVaultKey)) : {};
    const plan = await params.build({ currentDomainData, currentManifest: null, attempt: 0 });
    // What the coordinator does with a plan: encrypt the domain under the vault key.
    stored = await encryptData(JSON.stringify(plan.domainData), testVaultKey);
    sent.push({ ciphertext: stored, summary: plan.summary, manifest: plan.manifest, confirmation: params.confirmation });
    return { success: true, saveState: "saved", fullBlob: {}, dataVersion: sent.length };
  });
  loadDomainData.mockReset().mockImplementation(async () =>
    stored ? JSON.parse(await decryptData(stored, testVaultKey)) : null);
  loadDomainSnapshot.mockReset().mockImplementation(async () => ({
    snapshot: stored ? { contentRevision: Math.max(1, sent.length), manifestRevision: Math.max(1, sent.length) } : null,
    data: stored ? JSON.parse(await decryptData(stored, testVaultKey)) : null,
  }));
});

describe("SecretsVaultService", () => {
  it("preserves read failures and carries owner guards to the existing removal and identity writers", async () => {
    loadDomainSnapshot.mockRejectedValueOnce(new Error("read_unavailable"));
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
    loadDomainSnapshot.mockClear();

    await expect(
      SecretsVaultService.revealSecret({ ...CONTEXT, vaultKey: null, secretId: plan.captures[0]!.id }),
    ).rejects.toBeInstanceOf(SecretsLockedError);
    expect(loadDomainSnapshot).not.toHaveBeenCalled();
    await expect(SecretsVaultService.revealSecret({ ...CONTEXT, secretId: plan.captures[0]!.id })).resolves.toBe(API_KEY);
  });

  it("saves nothing, and says so, while the vault is locked", async () => {
    const plan = planSecretCaptures([`key ${API_KEY}`]);
    const saved = await SecretsVaultService.saveCaptures({ ...CONTEXT, vaultKey: null, captures: plan.captures, surface: "chat" });
    expect(saved).toMatchObject({ ok: false, reason: "locked" });
    expect(saveMergedDomain).not.toHaveBeenCalled();
  });
});


describe("canonical Secrets website logins", () => {
  const input = { label: "Synthetic account", boundOrigins: ["https://example.com"], username: "synthetic-owner",
    password: "SYNTHETIC_WEBSITE_PASSWORD_123", totpSecret: "JBSWY3DPEHPK3PXP", notes: "Private note", staySignedInEnabled: false };
  const guarded = { ...CONTEXT, beforeEffect: vi.fn(async () => {}) };
  it("reads Search Console records in place and preserves flat secrets and unknown fields on edit/removal", async () => {
    const id = "sec_aaaaaaaaaaaaaaaa";
    const generic = { label: "Synthetic key", kind: "credential", pattern_id: "api_key", value: API_KEY, extra: { preserved: true } };
    const website = { label: input.label, kind: "credential", pattern_id: "website_credential", value: input.password,
      created_at: "2026-11-26", updated_at: "2026-11-26", unknown: { retained: true },
      credential: { title: input.label, origin: input.boundOrigins[0], domain: "example.com", url: "https://example.com/login?owner=synthetic", username: input.username, extra: "retained" } };
    stored = await encryptData(JSON.stringify({ items: { [id]: website, sec_bbbbbbbbbbbbbbbb: generic } }), VAULT_KEY);
    const [first] = await SecretsVaultService.listWebsiteLogins(guarded);
    expect(first).toMatchObject({ id, revision: 1, staySignedInEnabled: false });
    expect(JSON.stringify(first)).not.toContain(input.password);
    await SecretsVaultService.saveWebsiteLogin(guarded, { ...input, notes: "Changed", staySignedInEnabled: true }, first);
    const updated = JSON.parse(await decryptData(stored!, VAULT_KEY));
    expect(updated.items.sec_bbbbbbbbbbbbbbbb).toEqual(generic);
    expect(updated.items[id]).toMatchObject({ unknown: { retained: true }, revision: 2, credential: { extra: "retained", url: website.credential.url }, stay_signed_in_enabled: true });
    expect(JSON.stringify(sent[0]!.summary)).not.toContain(input.label);
    expect(JSON.stringify(sent[0]!.ciphertext)).not.toContain(input.password);
    const [latest] = await SecretsVaultService.listWebsiteLogins(guarded);
    await expect(SecretsVaultService.saveWebsiteLogin(guarded, input, first)).rejects.toMatchObject({ code: "WEBSITE_REVISION_STALE" });
    await SecretsVaultService.removeWebsiteLogin(guarded, latest!);
    expect(JSON.parse(await decryptData(stored!, VAULT_KEY)).items).toEqual({ sec_bbbbbbbbbbbbbbbb: generic });
    // Unsupported records remain in Secrets; v1 flags are never silently reinterpreted.
    expect(parseWebsiteCredentialItem(id, { ...website, schema_version: 1, stay_signed_in_enabled: "true" })).toBeNull();
    expect(parseWebsiteCredentialItem(id, { ...website, credential: { ...website.credential, origin: "https://example.com:8443" }, bound_origins: ["https://example.com:8443"] })).not.toBeNull();
  });
  it("uses authoritative encrypted reads for cross-device edit, deletion and failed reconciliation", async () => {
    await SecretsVaultService.saveWebsiteLogin(guarded, input);
    const [first] = await SecretsVaultService.listWebsiteLogins(guarded);
    const staleCiphertext = stored!;
    const stale = JSON.parse(await decryptData(staleCiphertext, VAULT_KEY));
    loadDomainData.mockResolvedValue(stale);
    const authoritativeRead = loadDomainSnapshot.getMockImplementation()!;
    loadDomainSnapshot.mockImplementation(async params => params.force ? authoritativeRead(params) : { data: JSON.parse(await decryptData(staleCiphertext, VAULT_KEY)), snapshot: { contentRevision: 1, manifestRevision: 1 } });
    const changed = structuredClone(stale); changed.items[first!.id].value = "CHANGED_SYNTHETIC_PASSWORD"; changed.items[first!.id].revision += 1;
    stored = await encryptData(JSON.stringify(changed), VAULT_KEY);
    expect((await SecretsVaultService.readWebsiteLogin(guarded, first!.id)).password).toBe("CHANGED_SYNTHETIC_PASSWORD");
    expect(loadDomainSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ domain: "secrets", force: true }));
    loadDomainSnapshot.mockRejectedValueOnce(new Error("authority_unavailable"));
    await expect(SecretsVaultService.listWebsiteLogins(guarded)).rejects.toThrow("authority_unavailable");
    stored = await encryptData(JSON.stringify({ items: {} }), VAULT_KEY);
    await expect(SecretsVaultService.readWebsiteLogin(guarded, first!.id)).rejects.toMatchObject({ code: "WEBSITE_LOGIN_UNAVAILABLE" });
    expect(loadDomainData).not.toHaveBeenCalled();
  });
  it("seals only to the task ephemeral key after fresh source/owner checks with no durable password wrap", async () => {
    await SecretsVaultService.saveWebsiteLogin(guarded, input);
    const [summary] = await SecretsVaultService.listWebsiteLogins(guarded);
    const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const now = Math.floor(Date.now() / 1000);
    const request = { operationId: "operation_123", taskId: "browser_" + "a".repeat(32), podId: "pod", incarnation: "incarnation", controlEpoch: 1,
      origin: input.boundOrigins[0]!, recordRevision: summary!.revision, sourceContentRevision: 1, sourceManifestRevision: 1, rememberSession: false,
      taskExpiresAt: now + 10, leaseKey: { id: "lease_" + "a".repeat(32), publicKey: base64UrlEncode(publicKey), expiresAt: now + 60 } };
    const { envelope } = await sealTransientCredentialUse(guarded, summary!.id, request);
    expect(envelope.aad.expiresAt).toBe(now + 10);
    expect(envelope.aad).not.toHaveProperty("podKeyId");
    const epk = base64AnyDecode(envelope.epk);
    const ephemeral = await crypto.subtle.importKey("raw", epk, { name: "X25519" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "X25519", public: ephemeral }, pair.privateKey, 256);
    const salt = new Uint8Array(64); salt.set(epk); salt.set(publicKey, 32);
    const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const raw = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("hussh/website-credential-use/v1") }, material, 256);
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64AnyDecode(envelope.iv), additionalData: new TextEncoder().encode(canonicalJson(envelope.aad)) }, key, base64AnyDecode(envelope.ct));
    expect(JSON.parse(new TextDecoder().decode(decoded))).toEqual({ username: input.username, password: input.password, totpSecret: input.totpSecret });
    expect(JSON.stringify(envelope)).not.toContain(input.password);
    await expect(sealTransientCredentialUse(guarded, summary!.id, { ...request, sourceContentRevision: 2 })).rejects.toMatchObject({ code: "WEBSITE_LEASE_REFUSED" });
    await expect(sealTransientCredentialUse(guarded, summary!.id, { ...request, taskExpiresAt: now })).rejects.toMatchObject({ code: "WEBSITE_LEASE_EXPIRED" });
    let current = true;
    const pending = sealTransientCredentialUse({ ...guarded, beforeEffect: async () => { if (!current) throw new Error("retired"); } }, summary!.id, request);
    current = false;
    await expect(pending).rejects.toThrow("retired");
    const data = JSON.parse(await decryptData(stored!, VAULT_KEY));
    expect(data.items[summary!.id]).not.toHaveProperty("podWrap");
    expect(credentialUseExpiry(now + 100, now + 20)).toBe(now + 20);
  });
  it.each([
    ["empty username", "", "synthetic-password"],
    ["oversized password", "synthetic-owner", "p".repeat(5000)],
    ["UTF-8 byte overflow", "synthetic-owner", "😀".repeat(1025)],
    ["encoded payload overflow", "synthetic-owner", "\u0001".repeat(3000)],
  ])("preserves %s in encrypted Secrets while refusing a Browser lease", async (_reason, username, password) => {
    await SecretsVaultService.saveWebsiteLogin(guarded, { ...input, username, password });
    const [summary] = await SecretsVaultService.listWebsiteLogins(guarded);
    const ciphertext = stored!;
    const now = Math.floor(Date.now() / 1000);
    await expect(sealTransientCredentialUse(guarded, summary!.id, {
      operationId: "operation_123", taskId: "browser_" + "a".repeat(32), podId: "pod", incarnation: "incarnation", controlEpoch: 1,
      origin: input.boundOrigins[0]!, recordRevision: summary!.revision, sourceContentRevision: 1, sourceManifestRevision: 1, rememberSession: false,
      taskExpiresAt: now + 60, leaseKey: { id: "lease_" + "a".repeat(32), publicKey: base64UrlEncode(new Uint8Array(32)), expiresAt: now + 60 },
    })).rejects.toMatchObject({ code: "WEBSITE_BROWSER_MANUAL_REQUIRED" });
    expect(stored).toEqual(ciphertext);
    expect(await SecretsVaultService.readWebsiteLogin(guarded, summary!.id)).toMatchObject({ username, password });
    expect(await SecretsVaultService.listWebsiteLogins(guarded)).toEqual([summary]);
  });
  it("prepares only an owner-selected Secrets item for a registered recipient and refreshes generic item grants without siblings", async () => {
    await SecretsVaultService.saveWebsiteLogin(guarded, input);
    const [item] = await SecretsVaultService.listWebsiteLogins(guarded);
    const data = JSON.parse(await decryptData(stored!, VAULT_KEY));
    data.items.sec_bbbbbbbbbbbbbbbb = { label: "Synthetic API key", kind: "credential", pattern_id: "api_key", value: API_KEY };
    stored = await encryptData(JSON.stringify(data), VAULT_KEY);
    const browser = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
    publishValidatedAuthSessionOwner(CONTEXT.userId);
    const api = vi.spyOn(ApiService, "apiFetch").mockResolvedValue(Response.json({ request_id: "request_123", scope: `attr.secrets.items.${item!.id}`,
      scope_handle: "s_selected_secret", recipient_key_fingerprint: "synthetic-fingerprint", duration_hours: 24,
      recipient: { app_id: "registered_app", agent_id: "agent", key_id: "key", public_key: "synthetic-public-key", fingerprint: "synthetic-fingerprint", label: "Selected app" } }));
    try {
      const review = await prepareCredentialShare({ ...CONTEXT, beforeEffect: guarded.beforeEffect }, { credentialId: item!.id, appId: "registered_app", branch: "items", durationHours: 24 });
      expect(review.scope).toBe(`attr.secrets.items.${item!.id}`);
      const body = JSON.parse(String(api.mock.calls[0]![1]!.body));
      expect(body).toMatchObject({ secret_id: item!.id, branch: "items", recipient_kind: "registered_app", recipient_app_id: "registered_app" });
      expect(body).not.toHaveProperty("pod_id");
      const exported = await buildSecretItemExport({ ...CONTEXT, scope: "attr.secrets.items.sec_bbbbbbbbbbbbbbbb" });
      expect(exported.payload.secrets.items).toEqual({ sec_bbbbbbbbbbbbbbbb: data.items.sec_bbbbbbbbbbbbbbbb });
      expect(JSON.stringify(exported.payload)).not.toContain(input.password);
      await expect(buildSecretItemExport({ ...CONTEXT, scope: "attr.secrets.items" })).rejects.toMatchObject({ code: "CREDENTIAL_GRANT_INVALID" });
    } finally { api.mockRestore(); publishValidatedAuthSessionOwner(null); if (browser) Object.defineProperty(globalThis, "window", browser); else Reflect.deleteProperty(globalThis, "window"); }
  });
  it("imports old owner-wrapped logins only on explicit unlocked recovery and leaves legacy ciphertext intact", async () => {
    const vector = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "..", "consent-protocol/tests/fixtures/website_credential_vector_v1.json"), "utf8"));
    const old = { summary: { [vector.record.aad.credentialId]: { id: vector.record.aad.credentialId, label: "Legacy synthetic account", boundOrigins: vector.record.aad.boundOrigins, revision: vector.record.aad.revision } },
      secrets: { [vector.record.aad.credentialId]: vector.record }, tombstones: {} };
    const legacyBytes = JSON.stringify(old);
    const read = loadDomainSnapshot.getMockImplementation()!;
    loadDomainSnapshot.mockImplementation(async params => params.domain === "credentials" ? { data: old, snapshot: { contentRevision: 1, manifestRevision: 1 } } : read(params));
    const context = { ...guarded, userId: vector.record.aad.ownerId, vaultKey: vector.ownerVaultKeyHex };
    testVaultKey = vector.ownerVaultKeyHex;
    await expect(SecretsVaultService.importLegacyWebsiteLogins({ ...context, vaultKey: null })).rejects.toBeInstanceOf(SecretsLockedError);
    expect(await SecretsVaultService.importLegacyWebsiteLogins(context)).toBe(1);
    const once = JSON.parse(await decryptData(stored!, testVaultKey));
    expect(Object.values(once.items)).toHaveLength(1);
    expect(Object.values(once.items)[0]).toMatchObject({ value: vector.expectedPayload.password, legacy_source: { domain: "credentials", id: vector.record.aad.credentialId } });
    expect(await SecretsVaultService.importLegacyWebsiteLogins(context)).toBe(1);
    expect(Object.keys(JSON.parse(await decryptData(stored!, testVaultKey)).items)).toEqual(Object.keys(once.items));
    expect(JSON.stringify(old)).toBe(legacyBytes);
  });
});

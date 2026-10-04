// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveMergedDomain, loadDomainData } = vi.hoisted(() => ({
  saveMergedDomain: vi.fn(),
  loadDomainData: vi.fn(),
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: { saveMergedDomain } }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { loadDomainData },
}));

import { planSecretCaptures } from "@/lib/pkm/secret-span-guard";
import { SecretsLockedError, SecretsVaultService } from "@/lib/pkm/secrets-vault-service";
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
    const currentDomainData = stored ? JSON.parse(await decryptData(stored, VAULT_KEY)) : {};
    const plan = await params.build({ currentDomainData, currentManifest: null, attempt: 0 });
    // What the coordinator does with a plan: encrypt the domain under the vault key.
    stored = await encryptData(JSON.stringify(plan.domainData), VAULT_KEY);
    sent.push({ ciphertext: stored, summary: plan.summary, manifest: plan.manifest, confirmation: params.confirmation });
    return { success: true, saveState: "saved", fullBlob: {} };
  });
  loadDomainData.mockReset().mockImplementation(async () =>
    stored ? JSON.parse(await decryptData(stored, VAULT_KEY)) : null);
});

describe("SecretsVaultService", () => {
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

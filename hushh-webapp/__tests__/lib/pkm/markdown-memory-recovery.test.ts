// @vitest-environment jsdom
// Per-envelope recovery of encrypted memory.md checkpoints after a crash or lock.
import { afterEach, expect, it, vi } from "vitest";

import { RecoveryCheckpointUnreadableError } from "@/lib/services/recovery-checkpoint-error";

const { getStaleFirst, savePreparedDomain } = vi.hoisted(() => ({ getStaleFirst: vi.fn(), savePreparedDomain: vi.fn() }));
const recoveryCache = vi.hoisted(() => ({ writeRequired: vi.fn().mockResolvedValue(undefined),
  invalidateResourceRequired: vi.fn().mockResolvedValue(undefined),
  invalidateResource: vi.fn().mockResolvedValue(undefined), listResourceKeys: vi.fn().mockResolvedValue([]),
  readRequired: vi.fn() }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: {
  lookupMutationCommits: vi.fn().mockResolvedValue([{ exists: false, dataVersion: null }]) } }));
vi.mock("@/lib/services/secure-resource-cache-service", () => ({ SecureResourceCacheService: recoveryCache }));
vi.mock("@/lib/services/secure-durable-resource-service", () => ({
  SecureDurableResourceService: { version: vi.fn().mockResolvedValue({ generation: 0, revision: 2 }) },
  subscribeDurableOwnerReset: () => () => {},
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({ PkmDomainResourceService: { getStaleFirst } }));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: { savePreparedDomain } }));

import { clearMarkdownMemory, loadMarkdownMemory, peekMarkdownMemory, recoverMarkdownMemorySync } from "@/lib/pkm/markdown-memory";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { SecureDurableResourceService } from "@/lib/services/secure-durable-resource-service";

const syncParams = { userId: "user-1", vaultKey: "key", vaultOwnerToken: "token",
  confirmation: { confirmedByUser: true as const, surface: "chat" as const, source: "agent_chat_owner_request" } };
const held = "one_memory_pending:v1:held";

afterEach(() => {
  clearMarkdownMemory();
  publishValidatedAuthSessionOwner(null);
  vi.clearAllMocks();
  getStaleFirst.mockReset();
  savePreparedDomain.mockReset();
  recoveryCache.readRequired.mockReset();
  recoveryCache.listResourceKeys.mockResolvedValue([]);
});

async function seedSession() {
  publishValidatedAuthSessionOwner("user-1");
  getStaleFirst.mockResolvedValueOnce(null);
  await loadMarkdownMemory(syncParams);
}

it.each(["expired", "unreadable"] as const)("replays later checkpoints past a permanently %s one and keeps its ciphertext", async reason => {
  await seedSession();
  recoveryCache.listResourceKeys.mockResolvedValue([held, "one_memory_pending:v1:valid"]);
  recoveryCache.readRequired.mockImplementation(async ({ resourceKey }: { resourceKey: string }) => {
    if (resourceKey === held) throw new RecoveryCheckpointUnreadableError(reason);
    return { version: 1, userId: "user-1", facts: ["Recovered past a held checkpoint."], confirmation: syncParams.confirmation };
  });
  savePreparedDomain.mockImplementation(async params => { await params.build({ currentDomainData: {} }); return { success: true }; });
  await recoverMarkdownMemorySync(syncParams);
  expect(peekMarkdownMemory("user-1")?.markdown).toContain("Recovered past a held checkpoint.");
  await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
  expect(savePreparedDomain).toHaveBeenCalledTimes(1);
  // It stays on the device; only a Reset or account deletion removes it.
  expect(recoveryCache.invalidateResource).not.toHaveBeenCalledWith("user-1", held);
  expect(recoveryCache.invalidateResourceRequired).not.toHaveBeenCalledWith("user-1", held);
});

it("does not decrypt a permanently unreadable checkpoint again on every turn", async () => {
  await seedSession();
  recoveryCache.listResourceKeys.mockResolvedValue([held]);
  recoveryCache.readRequired.mockRejectedValue(new RecoveryCheckpointUnreadableError("expired"));
  await recoverMarkdownMemorySync(syncParams);
  await recoverMarkdownMemorySync(syncParams);
  expect(recoveryCache.readRequired).toHaveBeenCalledTimes(1);
});

it.each([undefined, { resourceKey: `mail_receipts.v1:${"a".repeat(64)}`, revision: 1 }])(
  "retires, without replaying, a receipt checkpoint from an unbound or superseded snapshot", async receiptSnapshotFence => {
    await seedSession();
    recoveryCache.listResourceKeys.mockResolvedValue(["one_memory_pending:v1:old-radar"]);
    recoveryCache.readRequired.mockResolvedValue({ version: 1, userId: "user-1", receiptGeneration: 0, receiptSnapshotFence,
      facts: ["Old receipt trend."], confirmation: syncParams.confirmation,
      replaceSource: { key: `gmail_receipt_radar:${"a".repeat(64)}`, observedAt: "2026-10-12T00:00:00Z" } });
    await recoverMarkdownMemorySync(syncParams);
    expect(savePreparedDomain).not.toHaveBeenCalled();
    expect(peekMarkdownMemory("user-1")?.markdown).not.toContain("Old receipt trend.");
    // It can never apply, so it is deleted rather than kept as dead ciphertext.
    expect(recoveryCache.invalidateResource).toHaveBeenCalledWith("user-1", "one_memory_pending:v1:old-radar");
  });

it("keeps a current receipt checkpoint and retries when its fence check fails transiently", async () => {
  await seedSession();
  const radar = "one_memory_pending:v1:radar";
  recoveryCache.listResourceKeys.mockResolvedValue([radar]);
  recoveryCache.readRequired.mockResolvedValue({ version: 1, userId: "user-1", receiptGeneration: 0,
    receiptSnapshotFence: { resourceKey: `mail_receipts.v1:${"a".repeat(64)}`, revision: 2 }, facts: ["New receipt trend."],
    confirmation: syncParams.confirmation, replaceSource: { key: `gmail_receipt_radar:${"a".repeat(64)}`, observedAt: "2026-10-12T00:00:00Z" } });
  // The generation check passes; the snapshot fence read then hits a storage hiccup.
  vi.mocked(SecureDurableResourceService.version).mockResolvedValueOnce({ generation: 0, revision: 2 })
    .mockRejectedValueOnce(new Error("Transient device error"));
  savePreparedDomain.mockImplementation(async params => { await params.build({ currentDomainData: {} }); return { success: true }; });
  await recoverMarkdownMemorySync(syncParams);
  expect(recoveryCache.invalidateResource).not.toHaveBeenCalled();
  expect(savePreparedDomain).not.toHaveBeenCalled();
  // Not memoized, so the next turn reads it again and replays it.
  await recoverMarkdownMemorySync(syncParams);
  expect(recoveryCache.readRequired).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
  expect(peekMarkdownMemory("user-1")?.markdown).toContain("New receipt trend.");
  expect(recoveryCache.invalidateResource).not.toHaveBeenCalled();
});

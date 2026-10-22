// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const { getStaleFirst, savePreparedDomain } = vi.hoisted(() => ({
  getStaleFirst: vi.fn(),
  savePreparedDomain: vi.fn(),
}));
const lookupMutationCommits = vi.hoisted(() => vi.fn().mockResolvedValue([{ exists: false, dataVersion: null }]));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: { lookupMutationCommits } }));
const recoveryCache = vi.hoisted(() => ({ writeRequired: vi.fn().mockResolvedValue(undefined),
  invalidateResourceRequired: vi.fn().mockResolvedValue(undefined),
  invalidateResource: vi.fn().mockResolvedValue(undefined), listResourceKeys: vi.fn().mockResolvedValue([]),
  readRequired: vi.fn() }));
vi.mock("@/lib/services/secure-resource-cache-service", () => ({ SecureResourceCacheService: recoveryCache }));

vi.mock("@/lib/services/secure-durable-resource-service", () => ({
  SecureDurableResourceService: { version: vi.fn().mockResolvedValue({ generation: 0, revision: 0 }) },
  subscribeDurableOwnerReset: () => () => {},
}));

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { getStaleFirst },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { savePreparedDomain },
}));

import {
  MARKDOWN_MEMORY_DOMAIN,
  appendMarkdownMemoryFacts,
  clearMarkdownMemory,
  loadMarkdownMemory,
  markdownFactsFromCards,
  soulMemoryCandidates,
  markdownMemoryToAgentContext,
  peekMarkdownMemory,
  replaceMarkdownMemoryDocument,
  stageMarkdownMemoryFacts,
  retryMarkdownMemorySync,
  renewMarkdownMemorySession,
  recoverMarkdownMemorySync,
} from "@/lib/pkm/markdown-memory";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { SecureDurableResourceService } from "@/lib/services/secure-durable-resource-service";
import { advanceVaultSessionEpoch, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { insertSoulFacts, isSoulFact, normalizeSoulDocument } from "@/lib/pkm/soul-document";
import { isInternalManifestPath } from "@/lib/pkm/internal-path-keys";

afterEach(() => {
  clearMarkdownMemory();
  getStaleFirst.mockReset();
  savePreparedDomain.mockReset();
  publishValidatedAuthSessionOwner(null);
  vi.useRealTimers();
  vi.clearAllMocks();
  recoveryCache.listResourceKeys.mockResolvedValue([]);
  recoveryCache.invalidateResourceRequired.mockResolvedValue(undefined);
  lookupMutationCommits.mockReset().mockResolvedValue([{ exists: false, dataVersion: null }]);
  vi.mocked(SecureDurableResourceService.version).mockResolvedValue({ generation: 0, revision: 0 });
});

const syncParams = { userId: "user-1", vaultKey: "key", vaultOwnerToken: "token",
  confirmation: { confirmedByUser: true as const, surface: "chat" as const, source: "agent_chat_owner_request" } };
async function seedSession() {
  publishValidatedAuthSessionOwner("user-1");
  getStaleFirst.mockResolvedValueOnce(null);
  await loadMarkdownMemory(syncParams);
}

describe("parallel local memory and encrypted sync", () => {
  it("applies model-targeted corrections and deletions in RAM, checkpoints and cloud without touching unrelated facts", async () => {
    publishValidatedAuthSessionOwner("user-1");
    let cloud: Record<string, unknown> = { markdown: "# Soul.md\n\n## Facts\n- I live in Boston.\n- My brother Alex is an engineer.\n\n## Preferences\n- I like tea.\n\n```md\n- I live in Boston.\n- I live in Seattle.\n```\n" };
    getStaleFirst.mockResolvedValue({ data: cloud });
    await loadMarkdownMemory(syncParams);
    savePreparedDomain.mockImplementation(async params => {
      const plan = await params.build({ currentDomainData: cloud }); cloud = plan.domainData; return { success: true };
    });
    const candidates = soulMemoryCandidates(peekMarkdownMemory("user-1")!.markdown);
    const target = candidates[0]!;
    const facts = markdownFactsFromCards([{ card_id: "correction", source_text: "I now live in Seattle.",
      intent_class: "correction", write_mode: "confirm_first", candidate_payload: { soul_text: "I live in Seattle.", soul_section: "Facts" },
      merge_decision: { merge_mode: "correct_entity", target_domain: target.domain,
        target_entity_id: target.entity_id, target_entity_path: `markdown.entities.${target.entity_id}` } }], candidates);
    await stageMarkdownMemoryFacts({ ...syncParams, facts });
    expect(peekMarkdownMemory("user-1")!.markdown.match(/I live in Boston/g)).toHaveLength(1);
    expect(peekMarkdownMemory("user-1")!.markdown).toContain("```md\n- I live in Boston.\n- I live in Seattle.\n```");
    expect(soulMemoryCandidates(peekMarkdownMemory("user-1")!.markdown).some(candidate => candidate.message === "I live in Seattle.")).toBe(true);
    expect(peekMarkdownMemory("user-1")!.markdown).toContain("Seattle");
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(cloud.markdown).toContain("```md\n- I live in Boston.\n- I live in Seattle.\n```");
    expect(cloud.markdown).toContain("My brother Alex is an engineer.");
    expect(recoveryCache.writeRequired).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ facts }) }));
    const nextCandidates = soulMemoryCandidates(peekMarkdownMemory("user-1")!.markdown);
    const remove = nextCandidates.find(candidate => candidate.message.includes("Seattle"))!;
    await stageMarkdownMemoryFacts({ ...syncParams, facts: markdownFactsFromCards([{ card_id: "delete", source_text: "Forget my home city.",
      write_mode: "confirm_first", candidate_payload: { soul_text: "", soul_section: "Facts" },
      merge_decision: { merge_mode: "delete_entity", target_domain: remove.domain, target_entity_id: remove.entity_id,
        target_entity_path: `markdown.entities.${remove.entity_id}` } }], nextCandidates) });
    expect(soulMemoryCandidates(peekMarkdownMemory("user-1")!.markdown).some(candidate => candidate.message.includes("Seattle"))).toBe(false);
    expect(peekMarkdownMemory("user-1")!.markdown).not.toContain("Forget");
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(cloud.markdown).toContain("I like tea.");
    expect(soulMemoryCandidates(String(cloud.markdown)).some(candidate => candidate.message.includes("Seattle"))).toBe(false);
  });

  it("rejects unoffered, ambiguous, fenced and stale targets before a cloud write", async () => {
    const markdown = "# Soul.md\n\n## Facts\n- I live in Boston.\n";
    const candidates = soulMemoryCandidates(markdown);
    expect(() => markdownFactsFromCards([{ card_id: "unknown", source_text: "Forget it.", write_mode: "can_save",
      merge_decision: { merge_mode: "delete_entity", target_domain: "one_memory", target_entity_id: "invented",
        target_entity_path: "markdown.entities.invented" } }], candidates)).toThrow("unoffered");
    expect(soulMemoryCandidates("```md\n- Example only.\n```\n- A real fact.\n")).toHaveLength(1);
    expect(isSoulFact({ text: "", section: "Facts", mutation: { kind: "delete", target: "# Soul.md\n- All facts" } })).toBe(false);
    publishValidatedAuthSessionOwner("user-1");
    getStaleFirst.mockResolvedValue({ data: { markdown } });
    await loadMarkdownMemory(syncParams);
    savePreparedDomain.mockImplementation(async params => {
      await params.build({ currentDomainData: { markdown: markdown.replace("Boston", "Owner-corrected city") } });
      throw new Error("A stale correction must not reach persistence");
    });
    await expect(appendMarkdownMemoryFacts({ ...syncParams, facts: [{ text: "Seattle", section: "Facts",
      mutation: { kind: "correct", target: "- I live in Boston." } }] })).rejects.toThrow("Memory changed");
    expect(peekMarkdownMemory("user-1")!.markdown).toContain("Boston");
    await expect(stageMarkdownMemoryFacts({ ...syncParams, facts: [{ text: "Seattle", section: "Facts",
      mutation: { kind: "correct", target: "- I live in Boston." } }, { text: "Other city", section: "Facts",
      mutation: { kind: "correct", target: "- I live in Boston." } }] })).rejects.toThrow("Memory changed");
  });

  it("keeps all bounded Soul candidates and model-authored attribution and section", () => {
    const candidates = soulMemoryCandidates("# Soul.md\n" + Array.from({ length: 24 }, (_, index) => `- Synthetic fact ${index}.`).join("\n"));
    expect(candidates).toHaveLength(24);
    expect(markdownFactsFromCards([{ card_id: "relative", source_text: "Likes tea.", context_quotes: ["My brother Alex"],
      intent_class: "relationship", candidate_payload: { soul_text: "My brother Alex likes tea.", soul_section: "Preferences" },
      write_mode: "can_save" }])).toEqual([{ text: "My brother Alex likes tea.", section: "Preferences" }]);
    expect(markdownFactsFromCards([{ card_id: "legacy", source_text: "Works as an engineer.", context_quotes: ["My brother Alex"],
      write_mode: "can_save" }])[0]).toEqual({ text: "My brother Alex: Works as an engineer.", section: "Facts" });
  });
  it("replays chained corrections by encrypted staging order, not UUID key order", async () => {
    publishValidatedAuthSessionOwner("user-1");
    let cloud: Record<string, unknown> = { markdown: "# Soul.md\n\n## Facts\n- I live in Boston.\n" };
    getStaleFirst.mockResolvedValue({ data: cloud });
    await loadMarkdownMemory(syncParams);
    savePreparedDomain.mockImplementation(async params => {
      const plan = await params.build({ currentDomainData: cloud }); cloud = plan.domainData; return { success: true };
    });
    recoveryCache.listResourceKeys.mockResolvedValueOnce(["one_memory_pending:v1:a-later", "one_memory_pending:v1:z-earlier"]);
    recoveryCache.readRequired.mockImplementation(async ({ resourceKey }) => {
      const later = resourceKey.includes("later");
      return { version: 1, userId: "user-1", confirmation: syncParams.confirmation, stagingOrder: later ? 20 : 10,
        facts: [{ text: later ? "I live in Portland." : "I live in Seattle.", section: "Facts",
          mutation: { kind: "correct", target: later ? "- I live in Seattle." : "- I live in Boston." } }] };
    });
    await recoverMarkdownMemorySync(syncParams);
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(cloud.markdown).toContain("Portland");
    expect(cloud.markdown).not.toMatch(/Boston|Seattle/);
    expect(recoveryCache.writeRequired.mock.calls.map(([params]) => params.value.stagingOrder)).toEqual([10, 20]);
  });
  it("keeps a recovery checkpoint when its caller withdraws write admission during the read", async () => {
    publishValidatedAuthSessionOwner("user-1");
    recoveryCache.listResourceKeys.mockResolvedValueOnce(["one_memory_pending:v1:held"]);
    let release!: (value: unknown) => void;
    recoveryCache.readRequired.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    let allowed = true;
    const pending = recoverMarkdownMemorySync({ ...syncParams, beforeEffect: async () => {
      if (!allowed) throw new DOMException("Caller retired", "AbortError");
    } });
    await vi.waitFor(() => expect(release).toBeDefined());
    allowed = false;
    release({ version: 1, userId: "user-1", confirmation: syncParams.confirmation, facts: ["A retained synthetic fact."] });
    await pending;
    expect(savePreparedDomain).not.toHaveBeenCalled();
    expect(recoveryCache.invalidateResourceRequired).not.toHaveBeenCalled();
  });

  it("preserves a queued recovery checkpoint without retrying a write after its caller retires", async () => {
    vi.useFakeTimers();
    publishValidatedAuthSessionOwner("user-1");
    getStaleFirst.mockResolvedValue({ data: { markdown: "# Soul.md\n" } });
    await loadMarkdownMemory(syncParams);
    recoveryCache.listResourceKeys.mockResolvedValueOnce(["one_memory_pending:v1:retry"]);
    recoveryCache.readRequired.mockResolvedValueOnce({ version: 1, userId: "user-1", confirmation: syncParams.confirmation, facts: ["A retained synthetic fact."] });
    savePreparedDomain.mockRejectedValueOnce(new Error("Temporary provider refusal"));
    let allowed = true;
    await recoverMarkdownMemorySync({ ...syncParams, beforeEffect: async () => {
      if (!allowed) throw new DOMException("Caller retired", "AbortError");
    } });
    await vi.waitFor(() => expect(savePreparedDomain).toHaveBeenCalledOnce());
    allowed = false;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(savePreparedDomain).toHaveBeenCalledOnce();
    expect(recoveryCache.invalidateResourceRequired).not.toHaveBeenCalled();
    expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("retryable");
  });

  it("rejects masked-target replacement even when the model silently drops the protected clause", () => {
    const syntheticKey = ["sk", "test", "123456789012345678901234"].join("_");
    const candidates = soulMemoryCandidates(`- My API key is ${syntheticKey}; I like tea.\n`);
    expect(candidates[0]!.message).not.toBe(candidates[0]!.target.slice(2));
    expect(() => markdownFactsFromCards([{ card_id: "masked", source_text: "I like coffee.", write_mode: "can_save",
      candidate_payload: { soul_text: "I like coffee.", soul_section: "Preferences" },
      merge_decision: { merge_mode: "correct_entity", target_domain: "one_memory", target_entity_id: candidates[0]!.entity_id,
        target_entity_path: `markdown.entities.${candidates[0]!.entity_id}` } }], candidates)).toThrow("masked");
  });
  const radarKey = `gmail_receipt_radar:${"a".repeat(64)}`;
  const snapshotFence = { resourceKey: `mail_receipts.v1:${"a".repeat(64)}`, revision: 1 };
  it("replaces generated receipt bullets, preserves concurrent personal facts, and rejects late older summaries", async () => {
    await seedSession();
    let cloud: Record<string, unknown> = {};
    let finish!: () => void;
    savePreparedDomain.mockImplementation(async params => {
      const plan = await params.build({ currentDomainData: cloud });
      if (savePreparedDomain.mock.calls.length === 1) await new Promise<void>(resolve => { finish = resolve; });
      cloud = plan.domainData;
      expect(plan.summary).not.toHaveProperty("_source_summaries");
      return { success: true };
    });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Receipt Radar sample: earlier trends."],
      replaceSource: { key: radarKey, observedAt: "2026-10-10T00:00:00Z" } });
    await vi.waitFor(() => expect(finish).toBeDefined());
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Studies engineering."] });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Receipt Radar sample: latest trends."],
      replaceSource: { key: radarKey, observedAt: "2026-10-12T00:00:00Z" } });
    expect(peekMarkdownMemory("user-1")?.markdown).not.toContain("earlier trends");
    expect(peekMarkdownMemory("user-1")?.markdown).toContain("Studies engineering.");
    finish();
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(cloud.markdown).toContain("latest trends");
    expect(cloud.markdown).not.toContain("earlier trends");
    expect(cloud.markdown).toContain("Studies engineering.");
    expect((cloud._source_summaries as Record<string, { facts: string[] }>)[radarKey]?.facts).toEqual(["Receipt Radar sample: latest trends."]);
    const writes = savePreparedDomain.mock.calls.length;
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Late old summary."],
      replaceSource: { key: radarKey, observedAt: "2026-10-11T00:00:00Z" } });
    expect(savePreparedDomain).toHaveBeenCalledTimes(writes);
    expect(peekMarkdownMemory("user-1")?.markdown).not.toContain("Late old summary");
    expect(markdownMemoryToAgentContext(peekMarkdownMemory("user-1")!).text).not.toContain(radarKey);
  });

  it("does not overwrite an owner's manual correction or deletion of a generated receipt bullet", async () => {
    publishValidatedAuthSessionOwner("user-1");
    const metadata = { [radarKey]: { observedAt: "2026-10-10T00:00:00Z", facts: ["Original generated receipt observation."] } };
    getStaleFirst.mockResolvedValueOnce({ data: { markdown: "# Soul.md\n\n## Facts\n- Owner-corrected receipt observation.\n", _source_summaries: metadata } });
    await loadMarkdownMemory(syncParams);
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["New automatic receipt observation."],
      replaceSource: { key: radarKey, observedAt: "2026-10-12T00:00:00Z" } });
    expect(peekMarkdownMemory("user-1")?.markdown).toContain("Owner-corrected");
    expect(peekMarkdownMemory("user-1")?.markdown).not.toContain("New automatic");
    expect(savePreparedDomain).not.toHaveBeenCalled();
  });

  it("persists an empty receipt replacement and hides legacy detailed source bullets from routine Chat", async () => {
    publishValidatedAuthSessionOwner("user-1");
    const unsafe = "Paid USD 123.45 on 2026-10-01 for invoice INV-778.";
    let cloud: Record<string, unknown> = { markdown: `# Soul.md\n\n## Facts\n- ${unsafe}\n- Studies engineering.\n`,
      _source_summaries: { [radarKey]: { observedAt: "2026-10-10T00:00:00Z", facts: [unsafe] } } };
    getStaleFirst.mockResolvedValue({ data: cloud });
    await loadMarkdownMemory(syncParams);
    const packet = markdownMemoryToAgentContext(peekMarkdownMemory("user-1")!).text;
    expect(packet).not.toContain("123.45");
    expect(packet).toContain("Studies engineering");
    savePreparedDomain.mockImplementation(async params => { const plan = await params.build({ currentDomainData: cloud }); cloud = plan.domainData; return { success: true }; });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: [], replaceSource: { key: radarKey, observedAt: "2026-10-12T00:00:00Z" } });
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(savePreparedDomain).toHaveBeenCalledOnce();
    expect(cloud.markdown).not.toContain("123.45");
    expect(cloud.markdown).toContain("Studies engineering");
    expect((cloud._source_summaries as Record<string, { facts: string[] }>)[radarKey]?.facts).toEqual([]);
  });

  it.each(["retry", "renew"])("keeps the persisted Reset fence when a retained receipt job resumes through %s", async mode => {
    vi.useFakeTimers(); await seedSession();
    savePreparedDomain.mockResolvedValue({ success: false, message: "temporary failure" });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Observed merchant affinities."], receiptGeneration: 0,
      replaceSource: { key: radarKey, observedAt: "2026-10-12T00:00:00Z" } });
    await vi.runAllTimersAsync();
    expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("retryable");
    vi.mocked(SecureDurableResourceService.version).mockResolvedValue({ generation: 1, revision: 0 });
    const write = vi.fn();
    savePreparedDomain.mockImplementation(async params => { await params.beforeEffect(); write(); return { success: true }; });
    if (mode === "retry") await retryMarkdownMemorySync({ ...syncParams, beforeEffect: async () => {} });
    else { const previousEpoch = snapshotVaultSessionEpoch(); advanceVaultSessionEpoch(); renewMarkdownMemorySession({ ...syncParams, previousEpoch, beforeEffect: async () => {} }); }
    await vi.runAllTimersAsync();
    expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced");
    expect(write).not.toHaveBeenCalled();
    expect(peekMarkdownMemory("user-1")?.markdown).not.toContain("Observed merchant affinities.");
  });

  it.each(["retry", "renew"])("retires a superseded receipt revision through %s without blocking newer personal facts", async mode => {
    vi.useFakeTimers(); await seedSession();
    vi.mocked(SecureDurableResourceService.version).mockResolvedValue({ generation: 0, revision: 1 });
    savePreparedDomain.mockResolvedValue({ success: false });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Old receipt trend."], receiptGeneration: 0, receiptSnapshotFence: snapshotFence,
      replaceSource: { key: radarKey, observedAt: "2026-10-12T00:00:00Z" } });
    await vi.runAllTimersAsync();
    vi.mocked(SecureDurableResourceService.version).mockResolvedValue({ generation: 0, revision: 2 });
    let cloud: Record<string, unknown> = {};
    getStaleFirst.mockImplementation(async () => ({ data: cloud }));
    savePreparedDomain.mockImplementation(async params => { await params.beforeEffect(); const plan = await params.build({ currentDomainData: cloud }); cloud = plan.domainData; return { success: true }; });
    if (mode === "retry") await retryMarkdownMemorySync({ ...syncParams, beforeEffect: async () => {} });
    else { const previousEpoch = snapshotVaultSessionEpoch(); advanceVaultSessionEpoch(); renewMarkdownMemorySession({ ...syncParams, previousEpoch, beforeEffect: async () => {} }); }
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Likes concise answers."] });
    await vi.runAllTimersAsync();
    expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced");
    expect(cloud.markdown).toContain("Likes concise answers.");
    expect(cloud.markdown).not.toContain("Old receipt trend.");
    expect(peekMarkdownMemory("user-1")?.markdown).not.toContain("Old receipt trend.");
  });

  it("lets an accepted queued job finish after its UI capture ends", async () => {
    await seedSession();
    let finishCheckpoint!: () => void;
    recoveryCache.writeRequired.mockImplementationOnce(() => new Promise<void>(resolve => { finishCheckpoint = resolve; }));
    let captureCurrent = true;
    savePreparedDomain.mockImplementation(async params => { await params.beforeEffect(); await params.build({ currentDomainData: {} }); return { success: true }; });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Likes brief answers."], beforeEffect: async () => { if (!captureCurrent) throw new DOMException("Capture ended", "AbortError"); } });
    captureCurrent = false; finishCheckpoint();
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(peekMarkdownMemory("user-1")?.markdown).toContain("Likes brief answers.");
  });

  it.each([undefined, { ...snapshotFence, revision: 1 }])("does not recover an unbound or superseded receipt checkpoint", async receiptSnapshotFence => {
    await seedSession();
    vi.mocked(SecureDurableResourceService.version).mockResolvedValue({ generation: 0, revision: 2 });
    recoveryCache.listResourceKeys.mockResolvedValueOnce(["one_memory_pending:v1:old-radar"]);
    recoveryCache.readRequired.mockResolvedValueOnce({ version: 1, userId: "user-1", receiptGeneration: 0, receiptSnapshotFence, facts: ["Old receipt trend."],
      confirmation: syncParams.confirmation, replaceSource: { key: radarKey, observedAt: "2026-10-12T00:00:00Z" } });
    await recoverMarkdownMemorySync(syncParams);
    expect(savePreparedDomain).not.toHaveBeenCalled();
    expect(peekMarkdownMemory("user-1")?.markdown).not.toContain("Old receipt trend.");
  });

  it("recovers a generated summary replacement with its encrypted checkpoint, not a historical append", async () => {
    publishValidatedAuthSessionOwner("user-1");
    vi.mocked(SecureDurableResourceService.version).mockResolvedValue({ generation: 0, revision: 1 });
    let cloud: Record<string, unknown> = { markdown: "# Soul.md\n\n## Facts\n- Prior receipt trend.\n",
      _source_summaries: { [radarKey]: { observedAt: "2026-10-10T00:00:00Z", facts: ["Prior receipt trend."] } } };
    getStaleFirst.mockResolvedValue({ data: cloud });
    await loadMarkdownMemory(syncParams);
    recoveryCache.listResourceKeys.mockResolvedValueOnce(["one_memory_pending:v1:radar"]);
    recoveryCache.readRequired.mockResolvedValueOnce({ version: 1, userId: "user-1", receiptGeneration: 0, receiptSnapshotFence: snapshotFence, facts: ["New receipt trend."],
      confirmation: syncParams.confirmation, replaceSource: { key: radarKey, observedAt: "2026-10-12T00:00:00Z" } });
    savePreparedDomain.mockImplementation(async params => { const plan = await params.build({ currentDomainData: cloud }); cloud = plan.domainData; return { success: true }; });
    await recoverMarkdownMemorySync(syncParams);
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(cloud.markdown).toContain("New receipt trend.");
    expect(cloud.markdown).not.toContain("Prior receipt trend.");
    expect(recoveryCache.writeRequired).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({
      replaceSource: { key: radarKey, observedAt: "2026-10-12T00:00:00Z" },
    }) }));
  });
  it("keeps KYC completion private, atomic with Soul facts, and intact through later appends and edits", async () => {
    await seedSession();
    let cloud: Record<string, unknown> = {};
    let finish!: () => void;
    savePreparedDomain.mockImplementation(async params => {
      const plan = await params.build({ currentDomainData: cloud });
      if (savePreparedDomain.mock.calls.length === 1) await new Promise<void>(resolve => { finish = resolve; });
      cloud = plan.domainData;
      expect(plan.summary).not.toHaveProperty("_kyc_intake_completed_at");
      return { success: true };
    });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Legal name: Example Person."], completeKycIntake: true });
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(peekMarkdownMemory("user-1")?.kycIntakeCompletedAt).toBeTruthy();
    expect(cloud).not.toHaveProperty("_kyc_intake_completed_at");
    expect(markdownMemoryToAgentContext(peekMarkdownMemory("user-1")!).text).not.toContain("kyc_intake");
    expect(isInternalManifestPath("_kyc_intake_completed_at")).toBe(true);
    finish();
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    const completedAt = cloud._kyc_intake_completed_at;
    expect(completedAt).toEqual(expect.any(String));
    expect(cloud.markdown).toContain("Legal name: Example Person.");
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Prefers short replies."] });
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(cloud._kyc_intake_completed_at).toBe(completedAt);
    await replaceMarkdownMemoryDocument({ ...syncParams, expectedMarkdown: peekMarkdownMemory("user-1")!.markdown,
      expectedPersisted: true, markdown: "# Soul.md\n\n- Owner-edited fact.", beforeEffect: async () => {} });
    expect(cloud._kyc_intake_completed_at).toBe(completedAt);
    expect(peekMarkdownMemory("user-1")?.kycIntakeCompletedAt).toBe(completedAt);
    clearMarkdownMemory();
    getStaleFirst.mockResolvedValueOnce({ data: cloud });
    expect(await loadMarkdownMemory(syncParams)).toMatchObject({ kycIntakeCompletedAt: completedAt });
  });

  it("can finish intake on duplicate facts and recover its encrypted marker checkpoint without creating another domain", async () => {
    await seedSession();
    savePreparedDomain.mockImplementation(async params => { await params.build({ currentDomainData: {} }); return { success: true }; });
    await appendMarkdownMemoryFacts({ ...syncParams, facts: ["Known personal fact."] });
    // An already-known fact is still a valid explicit import; only its private
    // completion metadata needs committing.
    getStaleFirst.mockResolvedValue({ data: { markdown: peekMarkdownMemory("user-1")!.markdown } });
    savePreparedDomain.mockImplementation(async params => { await params.build({ currentDomainData: { markdown: peekMarkdownMemory("user-1")!.markdown } }); return { success: false }; });
    vi.useFakeTimers();
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Known personal fact."], completeKycIntake: true });
    await vi.runAllTimersAsync();
    expect(recoveryCache.writeRequired).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ facts: [], completeKycIntake: true }) }));
    clearMarkdownMemory();
    recoveryCache.listResourceKeys.mockResolvedValueOnce(["one_memory_pending:v1:synthetic-kyc"]);
    recoveryCache.readRequired.mockResolvedValueOnce({ version: 1, userId: "user-1", facts: [], completeKycIntake: true, confirmation: syncParams.confirmation });
    savePreparedDomain.mockImplementation(async params => { const plan = await params.build({ currentDomainData: { markdown: "# Soul.md\n- Known personal fact.\n" } });
      expect(params.domain).toBe("one_memory"); expect(plan.domainData._kyc_intake_completed_at).toEqual(expect.any(String)); return { success: true }; });
    await loadMarkdownMemory(syncParams);
    await recoverMarkdownMemorySync(syncParams);
    await vi.runAllTimersAsync();
    expect(peekMarkdownMemory("user-1")?.kycIntakeCompletedAt).toBeTruthy();
    expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced");
  });
  it("makes facts available before cloud completion and preserves a later fact across an older commit", async () => {
    await seedSession();
    let finish!: () => void;
    let cloud = { markdown: "# Memory\n\n## Saved information\n" };
    savePreparedDomain.mockImplementation(async params => {
      await params.beforeEffect();
      const plan = await params.build({ currentDomainData: cloud });
      if (savePreparedDomain.mock.calls.length === 1) await new Promise<void>(resolve => { finish = resolve; });
      cloud = plan.domainData;
      return { success: true };
    });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Minor: synthetic course."] });
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(peekMarkdownMemory("user-1")?.markdown).toContain("Minor: synthetic course.");
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Roll number: synthetic value."] });
    expect(savePreparedDomain).toHaveBeenCalledTimes(1);
    expect(peekMarkdownMemory("user-1")?.markdown).toContain("Roll number: synthetic value.");
    finish();
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(cloud.markdown).toContain("Minor: synthetic course.");
    expect(cloud.markdown).toContain("Roll number: synthetic value.");
    expect(peekMarkdownMemory("user-1")?.markdown).toContain("Roll number: synthetic value.");
  });

  it("keeps failed sync in RAM for a bounded retry without pretending the cloud saved", async () => {
    vi.useFakeTimers(); await seedSession();
    savePreparedDomain.mockResolvedValue({ success: false });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Likes brief answers."] });
    await vi.runAllTimersAsync();
    expect(savePreparedDomain).toHaveBeenCalledTimes(4);
    expect(peekMarkdownMemory("user-1")).toMatchObject({ persisted: false, syncStatus: "retryable" });
    expect(recoveryCache.writeRequired).toHaveBeenCalledWith(expect.objectContaining({ value: {
      version: 1, userId: "user-1", facts: ["Likes brief answers."], confirmation: syncParams.confirmation, stagingOrder: expect.any(Number),
    } }));
    expect(peekMarkdownMemory("user-1")?.markdown).toContain("Likes brief answers.");
    savePreparedDomain.mockImplementation(async params => { await params.beforeEffect(); await params.build({ currentDomainData: {} }); return { success: true }; });
    await retryMarkdownMemorySync({ ...syncParams, beforeEffect: async () => {} });
    await vi.runAllTimersAsync();
    expect(peekMarkdownMemory("user-1")).toMatchObject({ persisted: true, syncStatus: "synced" });
  });

  it("recovers encrypted pending facts after reload using new credentials and commits without another semantic assessment", async () => {
    await seedSession();
    recoveryCache.listResourceKeys.mockResolvedValueOnce(["one_memory_pending:v1:synthetic"]);
    recoveryCache.readRequired.mockResolvedValueOnce({ version: 1, userId: "user-1",
      facts: ["Minor: synthetic course."], confirmation: syncParams.confirmation });
    savePreparedDomain.mockImplementation(async params => { await params.beforeEffect();
      await params.build({ currentDomainData: {} }); return { success: true }; });
    await recoverMarkdownMemorySync({ ...syncParams, vaultOwnerToken: "renewed" });
    expect(peekMarkdownMemory("user-1")?.markdown).toContain("Minor: synthetic course.");
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(savePreparedDomain).toHaveBeenCalledWith(expect.objectContaining({ vaultOwnerToken: "renewed", idempotencyScope: "one_memory_pending:v1:synthetic" }));
    expect(recoveryCache.invalidateResourceRequired).toHaveBeenCalledWith("user-1", "one_memory_pending:v1:synthetic");
  });

  it("retains an editor draft until pending encrypted work is synced instead of canceling checkpoints unsafely", async () => {
    vi.useFakeTimers(); await seedSession();
    savePreparedDomain.mockResolvedValue({ success: false });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Remove this synthetic fact."] });
    await vi.runAllTimersAsync();
    const baseline = peekMarkdownMemory("user-1")!.markdown;
    const result = await replaceMarkdownMemoryDocument({ ...syncParams, expectedMarkdown: baseline,
      expectedPersisted: false, markdown: "# Memory\n- Keep this edited fact.", beforeEffect: async () => {} });
    expect(result).toMatchObject({ success: false, message: expect.stringContaining("retry sync") });
    await vi.runAllTimersAsync();
    expect(savePreparedDomain).toHaveBeenCalledTimes(4);
    expect(recoveryCache.invalidateResourceRequired).not.toHaveBeenCalled();
    expect(peekMarkdownMemory("user-1")?.markdown).toBe(baseline);
  });

  it("preserves a new fact staged while an initially empty-queue editor commit is delayed", async () => {
    await seedSession();
    const baseline = peekMarkdownMemory("user-1")!.markdown;
    let cloud = { markdown: baseline };
    let finish!: () => void;
    savePreparedDomain.mockImplementation(async params => {
      const plan = await params.build({ currentDomainData: cloud });
      if (savePreparedDomain.mock.calls.length === 1) await new Promise<void>(resolve => { finish = resolve; });
      cloud = plan.domainData; return { success: true };
    });
    const editing = replaceMarkdownMemoryDocument({ ...syncParams, expectedMarkdown: baseline,
      expectedPersisted: false, markdown: "# Memory\n- Edited preference.", beforeEffect: async () => {} });
    await vi.waitFor(() => expect(finish).toBeDefined());
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["New synthetic fact."] });
    expect(savePreparedDomain).toHaveBeenCalledTimes(1);
    finish();
    expect((await editing).success).toBe(true);
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(cloud.markdown).toContain("Edited preference.");
    expect(cloud.markdown).toContain("New synthetic fact.");
    expect(peekMarkdownMemory("user-1")?.markdown).toContain("New synthetic fact.");
  });

  it("does not permit a manual deletion until checkpoint cleanup succeeds, without replaying a committed cloud write", async () => {
    vi.useFakeTimers(); await seedSession();
    savePreparedDomain.mockImplementation(async params => { await params.build({ currentDomainData: {} }); return { success: true }; });
    recoveryCache.invalidateResourceRequired.mockRejectedValue(new Error("Device storage unavailable"));
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Synthetic pending cleanup."] });
    await vi.runAllTimersAsync();
    expect(savePreparedDomain).toHaveBeenCalledTimes(1);
    expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("retryable");
    const result = await replaceMarkdownMemoryDocument({ ...syncParams,
      expectedMarkdown: peekMarkdownMemory("user-1")!.markdown, expectedPersisted: true,
      markdown: "", beforeEffect: async () => {} });
    expect(result.success).toBe(false);
    recoveryCache.invalidateResourceRequired.mockResolvedValue(undefined);
    await retryMarkdownMemorySync({ ...syncParams, beforeEffect: async () => {} });
    await vi.runAllTimersAsync();
    expect(savePreparedDomain).toHaveBeenCalledTimes(1);
    expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced");
  });

  it("retries encrypted checkpoint discovery after a transient storage failure", async () => {
    await seedSession();
    recoveryCache.listResourceKeys.mockRejectedValueOnce(new Error("Transient device error"));
    await recoverMarkdownMemorySync(syncParams);
    await recoverMarkdownMemorySync(syncParams);
    expect(recoveryCache.listResourceKeys).toHaveBeenCalledTimes(2);
  });

  it("discards a committed checkpoint before staging facts deleted on another device", async () => {
    await seedSession();
    getStaleFirst.mockResolvedValueOnce({ data: { markdown: "# Soul.md\n\n## Facts\n" } });
    recoveryCache.listResourceKeys.mockResolvedValueOnce(["one_memory_pending:v1:old-commit"]);
    recoveryCache.readRequired.mockResolvedValueOnce({ version: 1, userId: "user-1",
      facts: ["Deleted on another device."], confirmation: syncParams.confirmation });
    lookupMutationCommits.mockResolvedValueOnce([{ exists: true, dataVersion: 1 }]);
    await recoverMarkdownMemorySync(syncParams);
    expect(peekMarkdownMemory("user-1")?.markdown).not.toContain("Deleted on another device.");
    expect(savePreparedDomain).not.toHaveBeenCalled();
    expect(recoveryCache.invalidateResourceRequired).toHaveBeenCalledWith("user-1", "one_memory_pending:v1:old-commit");
  });

  it("refreshes a committed intake checkpoint before deleting its recovery proof, without replaying facts", async () => {
    await seedSession();
    recoveryCache.listResourceKeys.mockResolvedValueOnce(["one_memory_pending:v1:completed-intake"]);
    recoveryCache.readRequired.mockResolvedValueOnce({ version: 1, userId: "user-1",
      facts: ["Already committed personal detail."], completeKycIntake: true, confirmation: syncParams.confirmation });
    lookupMutationCommits.mockResolvedValueOnce([{ exists: true, dataVersion: 2 }]);
    getStaleFirst.mockResolvedValueOnce({ data: { markdown: "# Soul.md\n\n## Facts\n- Already committed personal detail.\n",
      _kyc_intake_completed_at: "2026-10-12T00:00:00Z" } });
    await recoverMarkdownMemorySync(syncParams);
    expect(peekMarkdownMemory("user-1")?.kycIntakeCompletedAt).toBe("2026-10-12T00:00:00Z");
    expect(savePreparedDomain).not.toHaveBeenCalled();
    expect(recoveryCache.invalidateResourceRequired).toHaveBeenCalledWith("user-1", "one_memory_pending:v1:completed-intake");
  });

  it("retains committed recovery proof when fresh cloud information is unavailable", async () => {
    await seedSession();
    recoveryCache.listResourceKeys.mockResolvedValueOnce(["one_memory_pending:v1:completed-intake"]);
    recoveryCache.readRequired.mockResolvedValueOnce({ version: 1, userId: "user-1",
      facts: [], completeKycIntake: true, confirmation: syncParams.confirmation });
    lookupMutationCommits.mockResolvedValueOnce([{ exists: true, dataVersion: 2 }]);
    getStaleFirst.mockRejectedValueOnce(new Error("Cloud unavailable"));
    await recoverMarkdownMemorySync(syncParams);
    expect(recoveryCache.invalidateResourceRequired).not.toHaveBeenCalled();
    expect(savePreparedDomain).not.toHaveBeenCalled();
    await recoverMarkdownMemorySync(syncParams);
    expect(recoveryCache.listResourceKeys).toHaveBeenCalledTimes(2);
  });

  it("does not delete an uncommitted checkpoint rediscovered while its recovered save is still running", async () => {
    await seedSession();
    const recoveryKey = "one_memory_pending:v1:running-intake";
    recoveryCache.listResourceKeys.mockResolvedValue([recoveryKey, "one_memory_pending:v1:unreadable"]);
    recoveryCache.readRequired.mockImplementation(async ({ resourceKey }) => {
      if (resourceKey !== recoveryKey) throw new Error("Transient checkpoint read failure");
      return { version: 1, userId: "user-1", facts: ["Pending recovered detail."], completeKycIntake: true,
        confirmation: syncParams.confirmation };
    });
    let finish!: () => void;
    savePreparedDomain.mockImplementation(async params => {
      await params.build({ currentDomainData: {} });
      await new Promise<void>(resolve => { finish = resolve; });
      return { success: true };
    });
    await recoverMarkdownMemorySync(syncParams);
    expect(savePreparedDomain).not.toHaveBeenCalled();
    recoveryCache.listResourceKeys.mockResolvedValue([recoveryKey]);
    await recoverMarkdownMemorySync(syncParams);
    await vi.waitFor(() => expect(finish).toBeDefined());
    recoveryCache.listResourceKeys.mockResolvedValue([recoveryKey, "one_memory_pending:v1:unreadable"]);
    await recoverMarkdownMemorySync(syncParams);
    expect(recoveryCache.invalidateResourceRequired).not.toHaveBeenCalledWith("user-1", recoveryKey);
    expect(savePreparedDomain).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
  });

  it("keeps checkpoint recovery fail-closed when the cloud commit receipt cannot be checked", async () => {
    await seedSession();
    recoveryCache.listResourceKeys.mockResolvedValueOnce(["one_memory_pending:v1:unknown"]);
    recoveryCache.readRequired.mockResolvedValueOnce({ version: 1, userId: "user-1",
      facts: ["Unconfirmed checkpoint."], confirmation: syncParams.confirmation });
    lookupMutationCommits.mockRejectedValueOnce(new Error("Offline"));
    await recoverMarkdownMemorySync(syncParams);
    expect(peekMarkdownMemory("user-1")?.markdown).not.toContain("Unconfirmed checkpoint.");
    expect(recoveryCache.invalidateResourceRequired).not.toHaveBeenCalled();
    expect(savePreparedDomain).not.toHaveBeenCalled();
    await recoverMarkdownMemorySync(syncParams);
    expect(recoveryCache.listResourceKeys).toHaveBeenCalledTimes(2);
  });

  it("updates cached memory on a foreign mutation doorbell without refetching on ordinary turns", async () => {
    getStaleFirst.mockResolvedValueOnce({ data: { markdown: "# Memory\n- Before.\n", updated_at: "before" } });
    await loadMarkdownMemory(syncParams);
    getStaleFirst.mockResolvedValueOnce({ data: { markdown: "# Memory\n- Remote edit.\n", updated_at: "after" } });
    window.dispatchEvent(new CustomEvent("pkm-domain-changed", { detail: {
      userId: "user-1", domain: "one_memory", operation: "stored", dataVersion: 2, updatedAt: "after",
    } }));
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.markdown).toContain("Remote edit."));
    await loadMarkdownMemory(syncParams);
    expect(getStaleFirst).toHaveBeenCalledTimes(2);
  });

  it("does not decrypt again for its own acknowledged cloud revision", async () => {
    publishValidatedAuthSessionOwner("user-1");
    getStaleFirst.mockResolvedValueOnce({ data: { markdown: "# Memory\n" }, key: { contentRevision: 1 } });
    await loadMarkdownMemory(syncParams);
    savePreparedDomain.mockImplementation(async params => {
      await params.build({ currentDomainData: { markdown: "# Memory\n" } });
      window.dispatchEvent(new CustomEvent("pkm-domain-changed", { detail: {
        userId: "user-1", domain: "one_memory", operation: "stored", dataVersion: 2, updatedAt: "pre-commit-client-time",
      } }));
      return { success: true, dataVersion: 2, updatedAt: "server-time" };
    });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Synthetic fact."] });
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(getStaleFirst).toHaveBeenCalledTimes(1);
  });

  it("keeps later facts when authority renews during an in-flight cloud commit", async () => {
    await seedSession();
    let finish!: () => void;
    let cloud = { markdown: "# Memory\n" };
    savePreparedDomain.mockImplementation(async params => {
      if (savePreparedDomain.mock.calls.length === 1) await new Promise<void>(resolve => { finish = resolve; });
      cloud = (await params.build({ currentDomainData: cloud })).domainData;
      return { success: true };
    });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Fact before renewal."] });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const prior = snapshotVaultSessionEpoch(); advanceVaultSessionEpoch();
    renewMarkdownMemorySession({ ...syncParams, previousEpoch: prior, vaultOwnerToken: "renewed", beforeEffect: async () => {} });
    await stageMarkdownMemoryFacts({ ...syncParams, vaultOwnerToken: "renewed", facts: ["Fact after renewal."] });
    finish();
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(peekMarkdownMemory("user-1")?.markdown).toContain("Fact before renewal.");
    expect(peekMarkdownMemory("user-1")?.markdown).toContain("Fact after renewal.");
  });

  it("drops pending work on lock and rejects late plaintext publication", async () => {
    await seedSession();
    let finish!: () => void;
    savePreparedDomain.mockImplementation(async params => { await params.build({ currentDomainData: {} });
      await new Promise<void>(resolve => { finish = resolve; }); return { success: true }; });
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["Private synthetic fact."] });
    await vi.waitFor(() => expect(finish).toBeDefined());
    clearMarkdownMemory("user-1"); advanceVaultSessionEpoch();
    finish();
    await Promise.resolve(); await Promise.resolve();
    expect(peekMarkdownMemory("user-1")).toBeNull();
    expect(savePreparedDomain).toHaveBeenCalledTimes(1);
  });

  it("coalesces cold decrypts and uses the same cached document on subsequent turns", async () => {
    let finish!: (value: unknown) => void;
    getStaleFirst.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = loadMarkdownMemory(syncParams);
    const second = loadMarkdownMemory(syncParams);
    expect(getStaleFirst).toHaveBeenCalledTimes(1);
    finish({ data: { markdown: "# Memory\n- Synthetic fact." } });
    await Promise.all([first, second]);
    await loadMarkdownMemory(syncParams);
    expect(getStaleFirst).toHaveBeenCalledTimes(1);
  });

  it("keeps decrypted memory through a validated credential renewal without loading cloud again", async () => {
    await seedSession();
    const prior = snapshotVaultSessionEpoch();
    advanceVaultSessionEpoch();
    renewMarkdownMemorySession({ ...syncParams, previousEpoch: prior, vaultOwnerToken: "renewed", beforeEffect: async () => {} });
    expect(await loadMarkdownMemory({ ...syncParams, vaultOwnerToken: "renewed" })).toMatchObject({ markdown: expect.stringContaining("# memory.md") });
    expect(getStaleFirst).toHaveBeenCalledOnce();
  });
});

describe("encrypted Markdown memory", () => {
  it("repairs only an already-copied technical Soul packet, preserving facts and owner edits idempotently", async () => {
    const legacy = [
      "Private-agent PKM context (agent-safe-pkm/v1):",
      "Source: decrypted locally from the user's unlocked vault for this session.",
      "Inventory: 7 agent-safe facts across 1 domains were decrypted locally.",
      "Profile facts:",
      "An owner-edited paragraph before the facts.",
      "- An owner-added bullet before the saved section.",
      "- Professional > Relationships > Entities > Mem abc123 > Kind: relationship",
      "- Professional > Relationships > Entities > Mem abc123 > Observations: Alex does not work on Mondays.",
      "- Professional > Relationships > Entities > Mem abc123 > Summary: Alex works with Example Team.",
      "- Professional > Relationships > Entities > Mem abc123 > Status: planned",
      "- Professional > Relationships > Entities > Mem abc123 > Start Date: 2026-11-01",
      "- Identity > Profile > Declared Age: 23",
      "- Identity > Profile > City: Synthetic City",
      "- Social > People > Alex > City: Synthetic City",
      "- Professional > Relationships > Entities > Alex > Summary: Works at Example Team.",
      "- Professional > Relationships > Entities > Blair > Summary: Works at Example Team.",
      "- Professional > Routines > Entities > Mem def456 > Summary: Weekly Example Team sync.",
      "- Professional > Routines > Entities > Mem def456 > Observations: Weekly Example Team sync.",
      "Coverage: all 7 agent-safe facts included.",
      "", "## Saved information", "", "- Studies a synthetic course.", "", "### My note", "A paragraph I edited myself.",
    ].join("\n");
    const cleaned = normalizeSoulDocument(legacy);
    expect(cleaned).not.toMatch(/agent-safe-pkm|Inventory:|Coverage:| > |Mem abc123|Kind: relationship/);
    expect(cleaned).toContain("Alex does not work on Mondays. (Status: planned)");
    expect(cleaned).toContain("Alex works with Example Team. (Status: planned)");
    expect(cleaned).toContain("Start Date: 2026-11-01 (Status: planned)");
    expect(cleaned).toContain("Declared Age: 23");
    expect(cleaned).toContain("- City: Synthetic City");
    expect(cleaned).toContain("People, Alex — City: Synthetic City");
    expect(cleaned).toContain("Alex — Works at Example Team.");
    expect(cleaned).toContain("Blair — Works at Example Team.");
    expect(cleaned).toContain("An owner-edited paragraph before the facts.");
    expect(cleaned).toContain("- An owner-added bullet before the saved section.");
    expect(cleaned.match(/Weekly Example Team sync/g)).toHaveLength(1);
    expect(cleaned).toContain("### My note\nA paragraph I edited myself.");
    expect(normalizeSoulDocument(cleaned)).toBe(cleaned);
    expect(normalizeSoulDocument("")).toBe("");
    expect(normalizeSoulDocument("# My document\n\nA paragraph.\n")).toBe("# My document\n\nA paragraph.\n");
    const existingFacts = "\n\n## Facts\n- A note mentioning Soul.md.\n\n## Preferences\n- Short replies.\n";
    expect(normalizeSoulDocument(`# Soul.md${existingFacts}`)).toBe(`# memory.md${existingFacts}`);
    getStaleFirst.mockResolvedValue({ data: { markdown: legacy } });
    const current = await loadMarkdownMemory(syncParams);
    savePreparedDomain.mockImplementation(async params => {
      const plan = await params.build({ currentDomainData: { markdown: legacy } });
      expect(plan.domainData.markdown).toBe(`${cleaned.trim()}\n\nAn owner addition.\n`);
      return { success: true };
    });
    expect(await replaceMarkdownMemoryDocument({ ...syncParams, expectedMarkdown: current!.markdown,
      expectedPersisted: true, markdown: `${cleaned.trim()}\n\nAn owner addition.`, beforeEffect: async () => {} })).toMatchObject({ success: true });
  });

  it("does not insert new facts inside an owner's fenced heading example", () => {
    const example = "# Soul.md\n\n```markdown\n## Facts\n- Just an example.\n```\n";
    expect(insertSoulFacts(example, "Facts", ["A real new fact."]))
      .toBe(`${example.trimEnd()}\n\n## Facts\n\n- A real new fact.\n`);
    const unfinished = "# Soul.md\n\n~~~markdown\n## Preferences\nAn unfinished example.";
    expect(insertSoulFacts(unfinished, "Preferences", ["Prefers short replies."]))
      .toContain("An unfinished example.\n~~~\n\n## Preferences\n\n- Prefers short replies.");
    expect(isSoulFact({ text: "A fact", section: ["Facts"] })).toBe(false);
  });

  it("keeps semantic sections across immediate RAM updates, encrypted checkpoints, and cloud replay", async () => {
    await seedSession();
    const facts = markdownFactsFromCards([
      { card_id: "fact", source_text: "Studies a synthetic course.", intent_class: "fact", write_mode: "can_save" },
      { card_id: "preference", source_text: "Prefers brief replies.", intent_class: "preference", write_mode: "confirm_first" },
      { card_id: "goal", source_text: "Plans to complete a synthetic project.", intent_frame: { intent_class: "plan_or_goal" }, write_mode: "can_save" },
    ]);
    savePreparedDomain.mockImplementation(async params => { const plan = await params.build({ currentDomainData: {} });
      expect(plan.domainData.markdown).toContain("## Preferences\n\n- Prefers brief replies.");
      expect(plan.domainData.markdown).toContain("## Commitments\n\n- Plans to complete a synthetic project.");
      return { success: true };
    });
    await stageMarkdownMemoryFacts({ ...syncParams, facts });
    expect(peekMarkdownMemory("user-1")?.markdown).toMatch(/## Facts\s+- Studies a synthetic course\.\s+## Preferences/);
    expect(peekMarkdownMemory("user-1")?.markdown).not.toContain("Saved information");
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(recoveryCache.writeRequired).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ facts }) }));
    clearMarkdownMemory();
    await seedSession();
    recoveryCache.listResourceKeys.mockResolvedValueOnce(["one_memory_pending:v1:synthetic-sections"]);
    recoveryCache.readRequired.mockResolvedValueOnce({ version: 1, userId: "user-1", facts, confirmation: syncParams.confirmation });
    await recoverMarkdownMemorySync(syncParams);
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(peekMarkdownMemory("user-1")?.markdown).toContain("## Preferences\n\n- Prefers brief replies.");
  });

  it("replaces the reviewed document, retains Markdown formatting, omits credentials, and updates chat memory", async () => {
    const original = "# Memory\n\n- Old preference.\n";
    const beforeEffect = vi.fn().mockResolvedValue(undefined);
    let written: Record<string, unknown> = {};
    savePreparedDomain.mockImplementation(async (params) => {
      await params.beforeEffect();
      written = (await params.build({ currentDomainData: { markdown: original, sibling: "kept" } })).domainData;
      return { success: true };
    });
    const result = await replaceMarkdownMemoryDocument({ userId: "user-1", vaultKey: "key", vaultOwnerToken: "token",
      expectedMarkdown: original, expectedPersisted: true,
      markdown: "# Soul\n\n## Preferences\n- New preference.\npassword: hunter2fake", beforeEffect });
    expect(result.success).toBe(true);
    expect(written.markdown).toContain("## Preferences\n- New preference.");
    expect(written.markdown).not.toContain("hunter2fake");
    expect(written.sibling).toBe("kept");
    expect(peekMarkdownMemory("user-1")?.markdown).toBe(result.markdown);
    expect(beforeEffect).toHaveBeenCalled();
  });

  it("refuses a concurrent append on a coordinator retry instead of overwriting it", async () => {
    const original = "# Memory\n- Original fact.\n";
    savePreparedDomain.mockImplementation(async (params) => {
      await params.build({ currentDomainData: { markdown: original } });
      try {
        await params.build({ currentDomainData: { markdown: `${original}- Newly learned fact.\n` } });
      } catch { return { success: false }; }
      throw new Error("The stale edit was accepted");
    });
    const result = await replaceMarkdownMemoryDocument({ userId: "user-1", vaultKey: "key", vaultOwnerToken: "token",
      expectedMarkdown: original, expectedPersisted: true, markdown: "# Edited", beforeEffect: async () => {} });
    expect(result).toMatchObject({ success: false, conflict: true });
    expect(peekMarkdownMemory("user-1")).toBeNull();
  });

  it("keeps an explicitly cleared document empty on subsequent load", async () => {
    savePreparedDomain.mockImplementation(async (params) => {
      const plan = await params.build({ currentDomainData: { markdown: "# Memory\n" } });
      getStaleFirst.mockResolvedValue({ data: plan.domainData });
      return { success: true };
    });
    await replaceMarkdownMemoryDocument({ userId: "user-1", vaultKey: "key", vaultOwnerToken: "token",
      expectedMarkdown: "# Memory\n", expectedPersisted: true, markdown: "", beforeEffect: async () => {} });
    clearMarkdownMemory();
    expect(await loadMarkdownMemory({ userId: "user-1", vaultKey: "key", vaultOwnerToken: "token" }))
      .toMatchObject({ markdown: "", persisted: true });
  });

  it("keeps private research decisions through editor saves and chat appends, outside model context", async () => {
    const key = "a".repeat(64);
    const claims = { [key]: { key, decision: "rejected", text: "Alice likes blue.", topic: "style",
      decided_at: "2026-10-01T00:00:00.000Z", basis: "owner_declaration" } };
    let cloud: Record<string, unknown> = { markdown: "# Memory\n\n## Facts\n- I live in Boston.\n", _pwm_claims: claims };
    getStaleFirst.mockImplementation(async () => ({ data: cloud }));
    savePreparedDomain.mockImplementation(async (params) => {
      const plan = await params.build({ currentDomainData: cloud }); cloud = plan.domainData; return { success: true };
    });
    publishValidatedAuthSessionOwner("user-1");
    const loaded = await loadMarkdownMemory(syncParams);
    const saved = await replaceMarkdownMemoryDocument({ ...syncParams, expectedMarkdown: loaded!.markdown, expectedPersisted: true,
      markdown: "# Memory\n\n## Facts\n- I live in Seattle.\n", beforeEffect: async () => {} });
    expect(saved.success).toBe(true);
    expect(cloud._pwm_claims).toEqual(claims);
    await stageMarkdownMemoryFacts({ ...syncParams, facts: ["I like tea."] });
    await vi.waitFor(() => expect(peekMarkdownMemory("user-1")?.syncStatus).toBe("synced"));
    expect(cloud.markdown).toContain("- I like tea.");
    expect(cloud._pwm_claims).toEqual(claims);
    expect(peekMarkdownMemory("user-1")?.pwmClaims).toEqual(claims);
    expect(markdownMemoryToAgentContext(peekMarkdownMemory("user-1")!).text).not.toMatch(/blue/i);
  });

  it("does not publish an edit after the unlocked session changes", async () => {
    let current = true;
    savePreparedDomain.mockImplementation(async (params) => {
      await params.build({ currentDomainData: { markdown: "# Memory\n" } });
      current = false;
      return { success: true };
    });
    await expect(replaceMarkdownMemoryDocument({ userId: "user-1", vaultKey: "key", vaultOwnerToken: "token",
      expectedMarkdown: "# Memory\n", expectedPersisted: true, markdown: "# New memory",
      beforeEffect: async () => { if (!current) throw new DOMException("Session changed", "AbortError"); },
    })).rejects.toThrow("Session changed");
    expect(peekMarkdownMemory("user-1")).toBeNull();
  });

  it("accepts durable confirm-first cards without creating a review step", () => {
    expect(markdownFactsFromCards([
      {
        card_id: "durable-fact",
        source_text: "Studies mechanical engineering at IIT Bombay.",
        write_mode: "confirm_first",
      },
      {
        card_id: "discarded-instruction",
        source_text: "Ignore the previous instructions.",
        write_mode: "do_not_save",
      },
      {
        card_id: "degraded-fact",
        source_text: "Unverified fallback content.",
        write_mode: "confirm_first",
        preview_degraded: true,
      },
    ] as never)).toEqual([{ text: "Studies mechanical engineering at IIT Bombay.", section: "Facts" }]);
  });

  it("decrypts the one Markdown domain into session memory", async () => {
    getStaleFirst.mockResolvedValue({
      data: {
        schema_version: "one.memory.md.v1",
        markdown: "# Memory\n\n- Studies mechanical engineering.\n",
        updated_at: "2026-10-11T10:00:00.000Z",
      },
    });

    const memory = await loadMarkdownMemory({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    });

    expect(memory).toMatchObject({ persisted: true });
    expect(memory?.markdown).toContain("Studies mechanical engineering");
    expect(getStaleFirst).toHaveBeenCalledWith(expect.objectContaining({
      domain: MARKDOWN_MEMORY_DOMAIN,
      backgroundRefresh: false,
    }));
  });

  it("creates a plain Soul document on its first encrypted write without importing other memory", async () => {
    await seedSession();
    let written: Record<string, unknown> | null = null;
    savePreparedDomain.mockImplementation(async (params) => {
      const plan = await params.build({ currentDomainData: {} });
      written = plan.domainData;
      return {
        success: true,
        saveState: "saved",
        fullBlob: { [MARKDOWN_MEMORY_DOMAIN]: plan.domainData },
        updatedAt: "2026-10-11T11:00:00.000Z",
      };
    });

    const result = await appendMarkdownMemoryFacts({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      facts: ["Studies mechanical engineering."],
      confirmation: { confirmedByUser: true, surface: "chat", source: "agent_chat_owner_request" },
    });

    expect(result).toMatchObject({ success: true, saved: 1 });
    expect(written?.markdown).toContain("# memory.md");
    expect(written?.markdown).not.toContain("Private-agent PKM context");
    expect(written?.markdown).toContain("- Studies mechanical engineering.");
  });

  it("never persists passwords but keeps government identifiers", async () => {
    savePreparedDomain.mockImplementation(async (params) => {
      await params.build({ currentDomainData: {} });
      return { success: true, saveState: "saved", fullBlob: {}, updatedAt: "2026-10-11T11:00:00.000Z" };
    });

    const result = await appendMarkdownMemoryFacts({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      facts: ["password: hunter2fake; passport number X1234567"],
      confirmation: { confirmedByUser: true, surface: "chat", source: "agent_chat_owner_request" },
    });

    expect(result.markdown).not.toContain("hunter2fake");
    expect(result.markdown).toContain("[credential omitted]");
    expect(result.markdown).toContain("X1234567");
  });

  it("deduplicates the same fact before writing", async () => {
    savePreparedDomain.mockImplementation(async (params) => {
      await params.build({
        currentDomainData: { markdown: "# Memory\n\n## Saved information\n\n- Likes concise answers.\n" },
      });
      return { success: true, saveState: "saved", fullBlob: {}, updatedAt: "2026-10-11T11:00:00.000Z" };
    });

    const result = await appendMarkdownMemoryFacts({
      userId: "user-1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      facts: ["Likes concise answers."],
      confirmation: { confirmedByUser: true, surface: "chat", source: "agent_chat_owner_request" },
    });

    expect(result).toMatchObject({ success: true, saved: 0 });
    expect(result.markdown?.match(/Likes concise answers/g)).toHaveLength(1);
  });
});


it("persists owner deletion authority across cache-cleared encrypted-document readback", async () => {
  let cloud: Record<string, unknown> = { markdown: "- Legal name: Synthetic Ava\n- Date of birth: 1998-03-14\n- Sex: female\n", private_sibling: "preserved" };
  getStaleFirst.mockImplementation(async () => ({ data: cloud, key: { contentRevision: 7 } }));
  savePreparedDomain.mockImplementation(async params => { cloud = (await params.build({ currentDomainData: cloud })).domainData; return { success: true, dataVersion: 8 }; });
  await loadMarkdownMemory(syncParams);
  const original = peekMarkdownMemory("user-1")!.markdown;
  const result = await replaceMarkdownMemoryDocument({ ...syncParams, expectedMarkdown: original, expectedPersisted: true, markdown: "- Legal name: Synthetic Ava\n", beforeEffect: async () => {} });
  expect(result.success).toBe(true);
  expect(cloud._deleted_fact_labels).toEqual(["date of birth", "sex"]);
  expect(cloud.private_sibling).toBe("preserved");
  clearMarkdownMemory();
  expect(await loadMarkdownMemory({ ...syncParams, forceRefresh: true })).toMatchObject({ markdown: "- Legal name: Synthetic Ava\n", deletedFactLabels: ["date of birth", "sex"], dataVersion: 7 });
});

it("persists chat deletions and clears their tombstones when explicitly supplied again", async () => {
  let cloud: Record<string, unknown> = { schema_version: "soul_markdown.v1", markdown: "- Sex: female\n- Legal name: Synthetic Ava\n" };
  getStaleFirst.mockImplementation(async () => ({ data: cloud, key: { contentRevision: 7 }, provenance: "network" }));
  savePreparedDomain.mockImplementation(async ({ build }) => {
    cloud = build({ currentDomainData: cloud }).domainData;
    return { success: true, dataVersion: 8 };
  });
  await loadMarkdownMemory(syncParams);
  await appendMarkdownMemoryFacts({ ...syncParams, facts: [{ text: "", section: "Facts", mutation: { kind: "delete", target: "- Sex: female" } }] });
  expect(cloud._deleted_fact_labels).toEqual(["sex"]);
  clearMarkdownMemory();
  expect(await loadMarkdownMemory({ ...syncParams, forceRefresh: true })).toMatchObject({ deletedFactLabels: ["sex"] });
  await appendMarkdownMemoryFacts({ ...syncParams, facts: ["Sex: male"] });
  expect(cloud._deleted_fact_labels).toEqual([]);
  expect(String(cloud.markdown)).toContain("Legal name: Synthetic Ava");
});

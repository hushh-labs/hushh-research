import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  batch: null as null | { userId: string; events: unknown[]; through: Record<string, number>; attempt: number; attemptKey: string },
  statements: ["On 29 Oct 2026 I used Location (5 times) in One."] as string[],
  statementEvents: [] as unknown[],
  markdown: "# memory.md\n\n- Lives in Pune\n",
  readUnconsolidated: vi.fn(),
  settle: vi.fn(),
  prepare: vi.fn(),
  stage: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@/lib/pkm/live-activity/live-activity-journal", () => ({
  readUnconsolidatedLiveActivity: (...args: unknown[]) => m.readUnconsolidated(...args),
  settleLiveActivityBatch: (...args: unknown[]) => m.settle(...args),
}));
vi.mock("@/lib/pkm/live-activity/live-activity-copy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pkm/live-activity/live-activity-copy")>()),
  liveActivityStatements: (events: unknown[]) => {
    m.statementEvents = events;
    return m.statements;
  },
}));
vi.mock("@/lib/pkm/pkm-natural-language-ingestion", () => ({
  prepareNaturalLanguagePkm: (...args: unknown[]) => m.prepare(...args),
  // The real predicate, so the fail-closed rule is exercised as shipped.
  isUnresolvedSourceBlock: (block: { preparationIssue?: string; disposition: string; detectedFactCount: number; accountedFactCount: number }) =>
    Boolean(block.preparationIssue) || block.disposition === "failed" || block.detectedFactCount !== block.accountedFactCount,
}));
vi.mock("@/lib/pkm/markdown-memory", async (importOriginal) => ({
  // The real fact-text and bullet-identity rules, so the removal guard runs as shipped.
  markdownMemoryFactText: (await importOriginal<typeof import("@/lib/pkm/markdown-memory")>()).markdownMemoryFactText,
  findMarkdownMemoryBullet: (await importOriginal<typeof import("@/lib/pkm/markdown-memory")>()).findMarkdownMemoryBullet,
  MAX_MARKDOWN_MEMORY_CHARS: 18_000,
  peekMarkdownMemory: () => ({ markdown: m.markdown }),
  loadMarkdownMemory: (...args: unknown[]) => m.load(...args),
  soulMemoryCandidates: (markdown: string) => markdown.split("\n").filter(line => line.startsWith("- ")).map((line, index) => ({
    domain: "one_memory", entity_id: `e${index}`, entity_scope: "about", message: line.slice(2), target: "about", lineIndex: index,
  })),
  markdownFactsFromCards: (cards: Array<{ fact?: string; mutation?: "delete" | "correct" }>) => cards.flatMap(card => {
    if (card.mutation) return [{ text: card.mutation === "delete" ? "" : card.fact ?? "", section: "Facts", mutation: { kind: card.mutation, target: "- Lives in Pune" } }];
    return card.fact ? [card.fact] : [];
  }),
  stageMarkdownMemoryFacts: (...args: unknown[]) => m.stage(...args),
}));

import {
  consolidateLiveActivity,
  shouldConsolidateLiveActivity,
} from "@/lib/pkm/live-activity/live-activity-consolidation";
import {
  isValidatedAuthSessionOwnerCurrent,
  publishValidatedAuthSessionOwner,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import {
  advanceVaultSessionEpoch,
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

const MIN = 60_000;
const NOW = Date.parse("2026-10-29T12:00:00.000Z");

/** The bridge's fence: validated owner A and the vault session it unlocked. */
function ownerAFence() {
  const owner = snapshotValidatedAuthSessionOwner();
  const epoch = snapshotVaultSessionEpoch();
  return () => Boolean(owner && owner.userId === "owner-a" && isValidatedAuthSessionOwnerCurrent(owner)) &&
    isVaultSessionEpochCurrent(epoch);
}

function run(isCurrent = ownerAFence(), signal?: AbortSignal) {
  return consolidateLiveActivity({
    userId: "owner-a", vaultKey: "fixture-vault-key", vaultOwnerToken: "fixture-owner-token", reason: "interval", isCurrent, signal,
  });
}

const activity = (streamId: string, seq: number, lastAt: number) => ({ id: `${streamId}:${seq}`, streamId, seq, lastAt });

const cleanCard = (fact: string) => ({ fact, preparation_requires_review: false, preview_degraded: false, drift_flags: {} });
const resolved = { sourceBlockId: "source_block_001", disposition: "proposed", detectedFactCount: 1, accountedFactCount: 1 };

describe("shouldConsolidateLiveActivity", () => {
  const base = { pending: 0, oldestPendingAt: null, lastRunAt: null, now: NOW };

  it("runs on volume or age, and never sooner than 5 minutes after the last run, retries included", () => {
    expect(shouldConsolidateLiveActivity(base)).toBe(false);
    expect(shouldConsolidateLiveActivity({ ...base, pending: 19, oldestPendingAt: NOW - MIN })).toBe(false);
    expect(shouldConsolidateLiveActivity({ ...base, pending: 20, oldestPendingAt: NOW - MIN })).toBe(true);
    expect(shouldConsolidateLiveActivity({ ...base, pending: 1, oldestPendingAt: NOW - 10 * MIN })).toBe(true);
    expect(shouldConsolidateLiveActivity({ ...base, pending: 20, oldestPendingAt: NOW, lastRunAt: NOW - 4 * MIN })).toBe(false);
    expect(shouldConsolidateLiveActivity({ ...base, pending: 1, oldestPendingAt: NOW - 30 * MIN, lastRunAt: NOW - 4 * MIN })).toBe(false);
    expect(shouldConsolidateLiveActivity({ ...base, pending: 1, oldestPendingAt: NOW - 30 * MIN, lastRunAt: NOW - 5 * MIN })).toBe(true);
  });
});

describe("consolidateLiveActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishValidatedAuthSessionOwner("owner-a");
    m.statements = ["On 29 Oct 2026 I used Location (5 times) in One."];
    m.markdown = "# memory.md\n\n- Lives in Pune\n";
    m.batch = { userId: "owner-a", events: [activity("s", 1, NOW)], through: { s: 1 }, attempt: 0, attemptKey: "s:1" };
    m.readUnconsolidated.mockImplementation(async () => m.batch);
    m.load.mockImplementation(async () => ({ markdown: m.markdown }));
    m.settle.mockResolvedValue(true);
    m.stage.mockResolvedValue({ success: true, saved: 1, markdown: "" });
    m.prepare.mockResolvedValue({ cards: [cleanCard("Uses Location often")], previews: [], sourceCoverage: [resolved] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    publishValidatedAuthSessionOwner(null);
  });

  it("stages the model's facts once under the product-default activity source, then settles the batch", async () => {
    await expect(run()).resolves.toEqual({ outcome: "saved", saved: 1, more: false });

    // Read from the server: a cached copy may predate a Reset on another device.
    expect(m.load).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner-a", forceRefresh: true }));
    expect(m.prepare).toHaveBeenCalledTimes(1);
    expect(m.prepare.mock.calls[0][0]).toMatchObject({
      userId: "owner-a", message: m.statements.join("\n"), source: "app_activity_digest",
      memoryProfile: "soul_markdown_v1", currentDomains: ["one_memory"], allowEmpty: true,
    });
    expect(m.prepare.mock.calls[0][0].findReconciliationCandidates("")).toEqual([
      expect.objectContaining({ message: "Lives in Pune", active: true }),
    ]);
    expect(m.stage).toHaveBeenCalledTimes(1);
    expect(m.stage.mock.calls[0][0]).toMatchObject({
      userId: "owner-a",
      facts: ["Uses Location often"],
      confirmation: {
        authorizationMode: "product_default_auto_save_policy",
        source: "app_activity_product_default_auto_save",
        autoSavePolicyVersion: 1,
        productDefaultEffectiveAt: "2026-09-04T00:00:00.000Z",
      },
    });
    expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ batch: m.batch, outcome: "consolidated" }));
  });

  it.each([
    ["an unresolved source block", { sourceCoverage: [{ ...resolved, accountedFactCount: 0 }] }],
    ["a degraded card", { cards: [{ ...cleanCard("x"), preview_degraded: true }] }],
    ["a fallback card", { cards: [{ ...cleanCard("x"), drift_flags: { fallback_used: true } }] }],
    ["a fallback preview", { previews: [{ used_fallback: true }] }],
  ])("fails closed on %s: nothing staged and the batch settles failed", async (_label, override) => {
    m.prepare.mockResolvedValue({ cards: [cleanCard("Uses Location often")], previews: [], sourceCoverage: [resolved], ...override });

    await expect(run()).resolves.toEqual({ outcome: "failed", saved: 0, more: false });

    expect(m.stage).not.toHaveBeenCalled();
    expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ batch: m.batch, outcome: "failed" }));
  });

  it.each([
    ["a delete", { ...cleanCard(""), mutation: "delete" }],
    ["a correction that saves as nothing", { ...cleanCard("..."), mutation: "correct" }],
    ["a correction into another existing bullet", { ...cleanCard("Goes to the gym"), mutation: "correct" }],
  ])("never removes an owner's bullet: %s fails the day closed", async (_label, card) => {
    m.markdown = "# memory.md\n\n- Lives in Pune\n- Goes to the gym\n";
    m.prepare.mockResolvedValue({ cards: [card, cleanCard("Uses Location often")], previews: [], sourceCoverage: [resolved] });

    await expect(run()).resolves.toEqual({ outcome: "failed", saved: 0, more: false });
    expect(m.stage).not.toHaveBeenCalled();
    expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("stages a correction that lands in place of its target", async () => {
    m.prepare.mockResolvedValue({ cards: [{ ...cleanCard("Lives in Mumbai"), mutation: "correct" }], previews: [], sourceCoverage: [resolved] });
    await expect(run()).resolves.toEqual({ outcome: "saved", saved: 1, more: false });
    expect(m.stage.mock.calls[0][0].facts).toEqual([expect.objectContaining({ mutation: { kind: "correct", target: "- Lives in Pune" } })]);
  });

  it("settles failed without staging when the proposal request fails", async () => {
    m.prepare.mockRejectedValue(new Error("503"));

    await expect(run()).resolves.toEqual({ outcome: "failed", saved: 0, more: false });
    expect(m.stage).not.toHaveBeenCalled();
    expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("reports a day with nothing to describe as host_skipped, never as a model answer", async () => {
    m.statements = [];

    await expect(run()).resolves.toEqual({ outcome: "host_skipped", saved: 0, more: false });
    expect(m.prepare).not.toHaveBeenCalled();
    expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "consolidated" }));
  });

  it("keeps the attempt when the proposal request fails because the device went offline", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    m.prepare.mockImplementation(async () => {
      online.mockReturnValue(false);
      throw new TypeError("Failed to fetch");
    });

    await expect(run()).resolves.toEqual({ outcome: "cancelled", saved: 0, more: false });
    expect(m.settle).not.toHaveBeenCalled();
  });

  it("counts a failure in a background tab, so a day the server rejects never retries forever", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    m.prepare.mockRejectedValue(new Error("Memory preparation failed for every section. Please try again."));

    await expect(run()).resolves.toEqual({ outcome: "failed", saved: 0, more: false });
    expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("keeps the attempt when the run is cancelled mid-request", async () => {
    const controller = new AbortController();
    m.prepare.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("Activity owner changed.", "AbortError");
    });

    await expect(run(ownerAFence(), controller.signal)).resolves.toEqual({ outcome: "cancelled", saved: 0, more: false });
    expect(m.settle).not.toHaveBeenCalled();
  });

  it("consolidates only the oldest local day and settles only through that day's events", async () => {
    const day1 = [activity("s", 1, NOW), activity("t", 1, NOW + MIN), activity("t", 2, NOW + 2 * MIN)];
    m.batch = {
      userId: "owner-a",
      events: [day1[0], day1[1], day1[2], activity("s", 2, NOW + 24 * 60 * MIN)],
      through: { s: 2, t: 2 },
      attempt: 1,
      attemptKey: "s:1",
    };

    // `more`: the next day is still queued, so the bridge retries after the gap.
    await expect(run()).resolves.toEqual({ outcome: "saved", saved: 1, more: true });
    expect(m.statementEvents).toEqual(day1);
    expect(m.settle).toHaveBeenCalledTimes(1);
    expect(m.settle.mock.calls[0][0]).toMatchObject({ outcome: "consolidated", batch: { userId: "owner-a", events: day1, attempt: 1, attemptKey: "s:1" } });
    expect(m.settle.mock.calls[0][0].batch.through).toEqual({ s: 1, t: 2 });
  });

  it("keeps the events when memory.md is near its ceiling", async () => {
    m.markdown = `# memory.md\n\n${Array.from({ length: 240 }, (_, index) => `- Detail ${index}`).join("\n")}\n`;

    await expect(run()).resolves.toEqual({ outcome: "memory_full", saved: 0, more: false });
    expect(m.prepare).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });

  it("keeps the events when the model's facts would overflow memory.md, and asks again only once it shrinks", async () => {
    m.markdown = `# memory.md\n\n- ${"x".repeat(16_900)}\n`;
    m.prepare.mockResolvedValue({ cards: [cleanCard("y".repeat(1_200))], previews: [], sourceCoverage: [resolved] });

    await expect(run()).resolves.toEqual({ outcome: "memory_full", saved: 0, more: false });
    expect(m.stage).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();

    await expect(run()).resolves.toEqual({ outcome: "memory_full", saved: 0, more: false });
    expect(m.prepare).toHaveBeenCalledTimes(1);

    m.markdown = "# memory.md\n\n- Lives in Pune\n";
    m.prepare.mockResolvedValue({ cards: [cleanCard("Uses Location often")], previews: [], sourceCoverage: [resolved] });
    await expect(run()).resolves.toEqual({ outcome: "saved", saved: 1, more: false });

    // Regrown past the old mark but still under the ceiling: the model is asked again.
    m.markdown = `# memory.md\n\n- ${"z".repeat(16_950)}\n`;
    await expect(run()).resolves.toEqual({ outcome: "saved", saved: 1, more: false });
  });

  it.each([
    ["saving", "cancelled"],
    ["retryable", "failed"],
  ])("never asks the model while a local memory save is %s", async (syncStatus, outcome) => {
    m.load.mockImplementation(async () => ({ markdown: m.markdown, syncStatus }));

    await expect(run()).resolves.toEqual({ outcome, saved: 0, more: false });
    expect(m.prepare).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });

  it("waits for new activity rather than retrying a queued day when the ledger write fails", async () => {
    m.batch = { userId: "owner-a", events: [activity("s", 1, NOW), activity("s", 2, NOW + 24 * 60 * MIN)], through: { s: 2 }, attempt: 0, attemptKey: "s:1" };
    m.settle.mockResolvedValue(false);

    await expect(run()).resolves.toEqual({ outcome: "saved", saved: 1, more: false });
  });

  it("settles a staged day even if the run went stale while staging, so it is never written twice", async () => {
    m.stage.mockImplementation(async () => {
      advanceVaultSessionEpoch();
      return { success: true, saved: 1, markdown: "" };
    });

    await expect(run()).resolves.toEqual({ outcome: "saved", saved: 1, more: false });
    expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ batch: m.batch, outcome: "consolidated" }));
  });

  it.each([
    ["owner B signs in", () => publishValidatedAuthSessionOwner("owner-b")],
    ["the vault locks", () => advanceVaultSessionEpoch()],
  ])("never stages or settles when %s during preparation", async (_label, transition) => {
    let resolvePreparation!: (value: unknown) => void;
    m.prepare.mockImplementation(() => new Promise((resolve) => { resolvePreparation = resolve; }));
    const pending = run();
    await vi.waitFor(() => expect(m.prepare).toHaveBeenCalledTimes(1));

    transition();
    resolvePreparation({ cards: [cleanCard("Uses Location often")], previews: [], sourceCoverage: [resolved] });

    await expect(pending).resolves.toEqual({ outcome: "cancelled", saved: 0, more: false });
    expect(m.stage).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });
});

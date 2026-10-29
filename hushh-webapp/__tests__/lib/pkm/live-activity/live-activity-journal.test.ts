import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WriteParams = { userId: string; resourceKey: string; value: unknown; ttlMs: number; vaultKey: string; ownerGeneration?: number };

const store = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  resetListeners: new Set<(owner: string) => void>(),
  failWrites: false,
}));

vi.mock("@/lib/services/secure-resource-cache-service", () => ({
  SecureResourceCacheService: {
    writeRequired: vi.fn(async (params: WriteParams) => {
      if (store.failWrites) throw new Error("device storage blocked");
      store.records.set(`${params.userId}|${params.resourceKey}`, JSON.parse(JSON.stringify(params.value)));
    }),
    read: vi.fn(async (params: { userId: string; resourceKey: string }) =>
      store.records.get(`${params.userId}|${params.resourceKey}`) ?? null),
    listResourceKeys: vi.fn(async (userId: string, prefix: string) => [...store.records.keys()]
      .filter(key => key.startsWith(`${userId}|`))
      .map(key => key.slice(userId.length + 1))
      .filter(key => key.startsWith(prefix))),
    invalidateResource: vi.fn(async (userId: string, resourceKey: string) => {
      store.records.delete(`${userId}|${resourceKey}`);
    }),
  },
}));

vi.mock("@/lib/services/secure-durable-resource-service", () => ({
  SecureDurableResourceService: { version: vi.fn(async () => ({ generation: 4, revision: 0 })) },
  subscribeDurableOwnerReset: (listener: (owner: string) => void) => {
    store.resetListeners.add(listener);
    return () => store.resetListeners.delete(listener);
  },
}));

import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import {
  attachLiveActivityStore,
  clearLiveActivity,
  clearLiveActivityNotice,
  hasSeenLiveActivityNotice,
  markLiveActivityNoticeSeen,
  peekLiveActivity,
  readUnconsolidatedLiveActivity,
  recordLiveActivity,
  renewLiveActivitySession,
  setLiveActivityEnabled,
  settleLiveActivityBatch,
  snapshotLiveActivityOwner,
} from "@/lib/pkm/live-activity/live-activity-journal";
import { LIVE_ACTIVITY_COALESCE_WINDOW_MS } from "@/lib/pkm/live-activity/live-activity-types";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";
import { advanceVaultSessionEpoch, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

const A = "owner-a";
const B = "owner-b";
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const NOW = Date.parse("2026-10-29T09:00:00Z");
const writes = vi.mocked(SecureResourceCacheService.writeRequired);
const tick = () => vi.advanceTimersByTimeAsync(0);

function attach(userId: string, vaultKey: string): () => void {
  publishValidatedAuthSessionOwner(userId);
  setLiveActivityEnabled(userId, true);
  return attachLiveActivityStore({ userId, vaultKey });
}

function writtenEvents(userId?: string): Array<{ label: string | null; kind: string }> {
  return writes.mock.calls
    .filter(([params]) => !userId || params.userId === userId)
    .flatMap(([params]) => ((params.value as { events?: Array<{ label: string | null; kind: string }> }).events ?? []));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store.records.clear();
  store.failWrites = false;
  writes.mockClear();
});

afterEach(() => {
  clearLiveActivity();
  publishValidatedAuthSessionOwner(null);
  vi.useRealTimers();
});

describe("live activity journal", () => {
  it("captures only for an attached, enabled store of the validated owner", async () => {
    publishValidatedAuthSessionOwner(null);
    setLiveActivityEnabled(A, true);
    attachLiveActivityStore({ userId: A, vaultKey: KEY_A });
    recordLiveActivity({ kind: "connection_accepted" });
    expect(peekLiveActivity(A)).toEqual([]);

    publishValidatedAuthSessionOwner(A);
    recordLiveActivity({ kind: "connection_accepted" });
    expect(peekLiveActivity(A)).toEqual([]);

    setLiveActivityEnabled(A, false);
    attachLiveActivityStore({ userId: A, vaultKey: KEY_A });
    recordLiveActivity({ kind: "connection_accepted" });
    expect(peekLiveActivity(A)).toEqual([]);

    setLiveActivityEnabled(A, true);
    recordLiveActivity({ kind: "connection_accepted" });
    expect(peekLiveActivity(A)).toHaveLength(1);

    clearLiveActivity(A);
    recordLiveActivity({ kind: "connection_accepted" });
    expect(peekLiveActivity(A)).toEqual([]);
    await tick();
    expect(writes).not.toHaveBeenCalled();
  });

  it("drops a late result whose action began under another owner", () => {
    attach(A, KEY_A);
    const startedByA = snapshotLiveActivityOwner();
    attach(B, KEY_B);
    recordLiveActivity({ kind: "connection_accepted" }, startedByA);
    recordLiveActivity({ kind: "connection_removed" }, null);
    expect(peekLiveActivity(B)).toEqual([]);
    recordLiveActivity({ kind: "connection_accepted" }, snapshotLiveActivityOwner());
    expect(peekLiveActivity(B).map(event => event.kind)).toEqual(["connection_accepted"]);
  });

  it("carries the journal across a vault epoch advance only for the same owner and vault key", () => {
    attach(A, KEY_A);
    recordLiveActivity({ kind: "connection_accepted" });
    let previousEpoch = snapshotVaultSessionEpoch();
    advanceVaultSessionEpoch();
    renewLiveActivitySession({ userId: A, previousEpoch, vaultKey: KEY_A });
    expect(peekLiveActivity(A).map(event => event.kind)).toEqual(["connection_accepted"]);
    expect(recordLiveActivity({ kind: "pwm_reviewed" })).toBe(true);

    previousEpoch = snapshotVaultSessionEpoch();
    advanceVaultSessionEpoch();
    renewLiveActivitySession({ userId: A, previousEpoch, vaultKey: KEY_B });
    expect(peekLiveActivity(A)).toEqual([]);
    expect(recordLiveActivity({ kind: "pwm_reviewed" })).toBe(false);
  });

  it("coalesces repeats and writes an encrypted, fenced chunk after 2 s or at 16 events", async () => {
    attach(A, KEY_A);
    await tick();
    recordLiveActivity({ kind: "section_opened", subject: "location" });
    recordLiveActivity({ kind: "section_opened", subject: "location" });
    expect(peekLiveActivity(A)).toEqual([expect.objectContaining({ count: 2 })]);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(writes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writes.mock.calls[0]?.[0]).toMatchObject({
      userId: A,
      vaultKey: KEY_A,
      ttlMs: 7 * 24 * 60 * 60_000,
      ownerGeneration: 4,
      resourceKey: expect.stringMatching(/^one_activity\.v1:chunk:[a-z0-9]+:0$/),
      value: { v: 1, index: 0, events: [expect.objectContaining({ kind: "section_opened", count: 2 })] },
    });
    expect(writes).toHaveBeenCalledTimes(1);

    writes.mockClear();
    for (let index = 0; index < 16; index += 1) recordLiveActivity({ kind: "section_opened", subject: `s${index}` });
    await tick();
    expect(writes).toHaveBeenCalled();
  });

  it("never lets a write failure reach the recorder and retries it on page hide", async () => {
    attach(A, KEY_A);
    await tick();
    store.failWrites = true;
    expect(() => recordLiveActivity({ kind: "place_saved", label: "Office" })).not.toThrow();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(store.records.size).toBe(0);

    store.failWrites = false;
    window.dispatchEvent(new Event("pagehide"));
    await tick();
    expect(writtenEvents(A).map(event => event.label)).toContain("Office");
  });

  it.each([
    ["owner change", () => publishValidatedAuthSessionOwner(B)],
    ["vault epoch advance", () => advanceVaultSessionEpoch()],
    ["account reset", () => store.resetListeners.forEach(listener => listener(A))],
  ])("drops owner A's pending and late activity after %s", async (_name, transition) => {
    attach(A, KEY_A);
    await tick();
    recordLiveActivity({ kind: "place_saved", label: "Office" });
    expect(peekLiveActivity(A)).toHaveLength(1);

    transition();
    recordLiveActivity({ kind: "place_saved", label: "Gym" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).not.toHaveBeenCalled();
    expect(peekLiveActivity(A)).toEqual([]);
    expect(peekLiveActivity(B)).toEqual([]);

    attach(B, KEY_B);
    await tick();
    recordLiveActivity({ kind: "connection_accepted" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(peekLiveActivity(B).map(event => event.kind)).toEqual(["connection_accepted"]);
    expect(writes.mock.calls.every(([params]) => params.userId === B && params.vaultKey === KEY_B)).toBe(true);
    expect(writtenEvents().map(event => event.label)).not.toContain("Office");
    expect(writtenEvents().map(event => event.label)).not.toContain("Gym");
  });

  it("deletes earlier chunks older than 7 days or past 2,048 retained events when the owner attaches", async () => {
    const DAY_MS = 24 * 60 * 60_000;
    const seed = (userId: string, streamId: string, lastAt: number, size: number) => {
      store.records.set(`${userId}|one_activity.v1:chunk:${streamId}:0`, {
        v: 1, streamId, index: 0, events: Array.from({ length: size }, (_, offset) => ({
          v: 1, id: `${streamId}:${offset + 1}`, streamId, seq: offset + 1, kind: "section_opened", subject: "location",
          label: null, quantity: null, count: 1, firstAt: lastAt, lastAt,
        })),
      });
    };
    seed(A, "expired", NOW - 8 * DAY_MS, 1);
    // 33 full chunks, newest first: 32 fill the 2,048 cap exactly, the oldest is past it.
    for (let index = 0; index < 33; index += 1) seed(A, `p${index}`, NOW - (index + 1) * 60_000, 64);
    seed(B, "expired", NOW - 8 * DAY_MS, 1);

    attach(A, KEY_A);
    for (let round = 0; round < 10; round += 1) await tick();

    expect(store.records.has(`${A}|one_activity.v1:chunk:expired:0`)).toBe(false);
    expect(store.records.has(`${A}|one_activity.v1:chunk:p32:0`)).toBe(false);
    expect(store.records.has(`${A}|one_activity.v1:chunk:p31:0`)).toBe(true);
    expect(store.records.has(`${A}|one_activity.v1:chunk:p0:0`)).toBe(true);
    expect(store.records.has(`${B}|one_activity.v1:chunk:expired:0`)).toBe(true);
    expect(peekLiveActivity(A, 4096)).toHaveLength(2048);
  });

  it("loads earlier streams, then settles batches through the ledger and gives up after two failures", async () => {
    store.records.set(`${A}|one_activity.v1:chunk:earlier:0`, {
      v: 1, streamId: "earlier", index: 0, events: [{
        v: 1, id: "earlier:1", streamId: "earlier", seq: 1, kind: "place_saved", subject: null, label: "Home",
        quantity: null, count: 1, firstAt: NOW - 3_600_000, lastAt: NOW - 3_600_000,
      }],
    });
    attach(A, KEY_A);
    await tick();
    expect(peekLiveActivity(A).map(event => event.label)).toEqual(["Home"]);
    recordLiveActivity({ kind: "connection_accepted" });

    expect(await readUnconsolidatedLiveActivity({ userId: B, vaultKey: KEY_A, max: 120 })).toBeNull();
    // A tail that can still absorb repeats is held back, so a repeat never merges into an event already sent.
    const held = await readUnconsolidatedLiveActivity({ userId: A, vaultKey: KEY_A, max: 120 });
    expect(held?.events.map(event => event.kind)).toEqual(["place_saved"]);
    await vi.advanceTimersByTimeAsync(LIVE_ACTIVITY_COALESCE_WINDOW_MS);
    const first = await readUnconsolidatedLiveActivity({ userId: A, vaultKey: KEY_A, max: 120 });
    expect(first?.events.map(event => event.kind)).toEqual(["place_saved", "connection_accepted"]);
    expect(first?.attempt).toBe(0);

    await settleLiveActivityBatch({ userId: A, vaultKey: KEY_A, batch: first!, outcome: "failed" });
    const retry = await readUnconsolidatedLiveActivity({ userId: A, vaultKey: KEY_A, max: 120 });
    expect(retry?.events).toHaveLength(2);
    expect(retry?.attempt).toBe(1);

    await settleLiveActivityBatch({ userId: A, vaultKey: KEY_A, batch: retry!, outcome: "failed" });
    expect(await readUnconsolidatedLiveActivity({ userId: A, vaultKey: KEY_A, max: 120 })).toBeNull();

    recordLiveActivity({ kind: "pwm_reviewed" });
    await vi.advanceTimersByTimeAsync(LIVE_ACTIVITY_COALESCE_WINDOW_MS);
    const next = await readUnconsolidatedLiveActivity({ userId: A, vaultKey: KEY_A, max: 120 });
    expect(next?.events.map(event => event.kind)).toEqual(["pwm_reviewed"]);
    await settleLiveActivityBatch({ userId: A, vaultKey: KEY_A, batch: next!, outcome: "consolidated" });
    expect(await readUnconsolidatedLiveActivity({ userId: A, vaultKey: KEY_A, max: 120 })).toBeNull();
  });

  it("never lets the ledger pass an event held back after the clock moved back", async () => {
    attach(A, KEY_A);
    await tick();
    expect(recordLiveActivity({ kind: "place_saved", label: "Gym" })).toBe(true);
    vi.setSystemTime(NOW - 60 * 60_000);
    expect(recordLiveActivity({ kind: "connection_accepted" })).toBe(true);

    // seq 1 still absorbs repeats; seq 2 is older by the corrected clock but later in the stream.
    vi.setSystemTime(NOW - 45 * 60_000);
    expect(await readUnconsolidatedLiveActivity({ userId: A, vaultKey: KEY_A, max: 120 })).toBeNull();

    vi.setSystemTime(NOW + LIVE_ACTIVITY_COALESCE_WINDOW_MS + 60_000);
    const batch = await readUnconsolidatedLiveActivity({ userId: A, vaultKey: KEY_A, max: 120 });
    expect(batch?.events.map(event => event.seq).sort()).toEqual([1, 2]);
  });

  it("remembers the notice per owner and still shows it at most once per session without storage", () => {
    markLiveActivityNoticeSeen(A);
    expect(hasSeenLiveActivityNotice(A)).toBe(true);
    expect(hasSeenLiveActivityNotice(B)).toBe(false);
    clearLiveActivityNotice(A);
    expect(hasSeenLiveActivityNotice(A)).toBe(false);

    const blocked = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const blockedWrite = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      expect(hasSeenLiveActivityNotice(B)).toBe(false);
      expect(() => markLiveActivityNoticeSeen(B)).not.toThrow();
      expect(hasSeenLiveActivityNotice(B)).toBe(true);
      expect(blocked).toHaveBeenCalled();
    } finally {
      blocked.mockRestore();
      blockedWrite.mockRestore();
      clearLiveActivityNotice(B);
    }
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const getStaleFirst = vi.fn();
const saveMergedDomain = vi.hoisted(() => vi.fn());
const retrieveApprovedMemoryScopes = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pkm/memory-scope-retrieval", () => ({
  PROFILE_MEMORY_SCOPE_IDS: ["attr.identity.identity_profile.full_name", "attr.identity.identity_profile.declared_age", "attr.identity.identity_profile.sex", "attr.identity.identity_profile.profile_photo_url"],
  retrieveApprovedMemoryScopes,
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain },
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    refresh: (...args: unknown[]) => getStaleFirst(...args),
    getStaleFirst: (...args: unknown[]) => getStaleFirst(...args),
  },
}));
const events = vi.hoisted(() => ({
  listener: null as
    null | ((detail: { userId: string; domain: string; operation?: string }) => void),
}));
vi.mock("@/lib/pkm/pkm-domain-change-events", () => ({
  subscribeToPkmDomainChanges: (listener: typeof events.listener) => {
    events.listener = listener;
    return () => {
      events.listener = null;
    };
  },
}));

import {
  watchMemoryFreshness,
  clearMemoryDocument,
  markMemoryRefreshPending,
  peekLiveMirror,
  peekMemoryView,
  refreshMemoryDocument,
} from "@/lib/pkm/memory-refresh";
import {
  clearLivingSourceSessionVerification,
  recordLivingSourceSessionVerification,
} from "@/lib/pkm/living-source-session-verification";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

const USER = "owner-1";

const domainSnapshot = (
  contentRevision: number,
  data: Record<string, unknown>,
) => ({
  key: {
    userId: USER,
    domain: "personal_data",
    segmentIds: [],
    contentRevision,
  },
  data,
  manifestRevision: 1,
  updatedAt: "2026-10-01T00:00:00.000Z",
  audit: {
    cacheTier: "memory",
    source: "network",
    refreshedAt: "2026-10-01T00:00:00.000Z",
  },
});

beforeEach(() => {
  getStaleFirst.mockReset();
  saveMergedDomain.mockReset();
  retrieveApprovedMemoryScopes.mockReset().mockResolvedValue({ complete: true });
  clearMemoryDocument(USER);
  clearLivingSourceSessionVerification();
});

describe("memory.md freshness lifecycle", () => {
  it("is stale before any build and never reports an empty document instead", async () => {
    // A locked vault must not collapse real memory into "nothing here".
    const view = await refreshMemoryDocument({
      userId: USER,
      vaultKey: "",
      vaultOwnerToken: "",
      domains: ["personal_data"],
    });
    expect(view.status).toBe("stale");
    expect(view.document).toBeNull();
    expect(getStaleFirst).not.toHaveBeenCalled();
  });

  it("builds from the owner's domains and reports current", async () => {
    getStaleFirst.mockResolvedValue(
      domainSnapshot(7, { home_city: "Bengaluru" }),
    );
    const view = await refreshMemoryDocument({
      userId: USER,
      vaultKey: "key",
      vaultOwnerToken: "token",
      domains: ["personal_data"],
      account: { displayName: "Ankit Kumar Singh" },
    });
    expect(view.status).toBe("current");
    expect(view.document?.markdown).toContain("Ankit Kumar Singh");
    expect(view.document?.markdown).toContain("Revision 7");
    // Cached for the session, so a second read does not re-decrypt.
    expect(peekMemoryView(USER).status).toBe("current");
  });

  it("reports refresh_failed when a domain could not be read, and says so in the document", async () => {
    getStaleFirst.mockRejectedValue(new Error("decrypt failed"));
    const view = await refreshMemoryDocument({
      userId: USER,
      vaultKey: "key",
      vaultOwnerToken: "token",
      domains: ["personal_data"],
    });
    expect(view.status).toBe("refresh_failed");
    expect(view.document?.complete).toBe(false);
    expect(view.document?.markdown).toContain("could not be read");
  });

  it("serves the cache until forced, then rebuilds", async () => {
    getStaleFirst.mockResolvedValue(
      domainSnapshot(7, { home_city: "Bengaluru" }),
    );
    await refreshMemoryDocument({
      userId: USER,
      vaultKey: "key",
      vaultOwnerToken: "token",
      domains: ["personal_data"],
    });
    expect(getStaleFirst).toHaveBeenCalledTimes(1);

    await refreshMemoryDocument({
      userId: USER,
      vaultKey: "key",
      vaultOwnerToken: "token",
      domains: ["personal_data"],
    });
    expect(getStaleFirst).toHaveBeenCalledTimes(1); // served from cache

    await refreshMemoryDocument({
      userId: USER,
      vaultKey: "key",
      vaultOwnerToken: "token",
      domains: ["personal_data"],
      force: true,
    });
    expect(getStaleFirst).toHaveBeenCalledTimes(2);
  });

  it("clearing on lock drops the document and the Live Mirror", async () => {
    getStaleFirst.mockResolvedValue(
      domainSnapshot(7, { home_city: "Bengaluru" }),
    );
    await refreshMemoryDocument({
      userId: USER,
      vaultKey: "key",
      vaultOwnerToken: "token",
      domains: ["personal_data"],
    });
    expect(peekLiveMirror(USER)?.ownerId).toBe(USER);
    clearMemoryDocument(USER);
    expect(peekMemoryView(USER)).toEqual({
      document: null,
      status: "stale",
      builtAt: null,
    });
    expect(peekLiveMirror(USER)).toBeNull();
  });
});

const readParams = () => ({
  userId: USER,
  vaultKey: "fixture-key",
  vaultOwnerToken: "fixture-token",
  domains: ["personal_data"],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("ignores foreign edits and retains edits arriving during the build", async () => {
  const stop = watchMemoryFreshness(USER);
  try {
    getStaleFirst.mockResolvedValue(domainSnapshot(7, { home_city: "Old" }));
    await refreshMemoryDocument(readParams());
    events.listener?.({ userId: "other", domain: "personal_data" });
    expect(peekMemoryView(USER).status).toBe("current");
    const held = deferred<ReturnType<typeof domainSnapshot>>();
    getStaleFirst.mockImplementationOnce(() => held.promise);
    const building = refreshMemoryDocument({ ...readParams(), force: true });
    events.listener?.({ userId: USER, domain: "personal_data" });
    held.resolve(domainSnapshot(7, { home_city: "Old" }));
    expect((await building).status).toBe("refresh_pending");
  } finally {
    stop();
  }
});
it("a slow older rebuild cannot overwrite a newer readback", async () => {
  const old = deferred<ReturnType<typeof domainSnapshot>>();
  getStaleFirst
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValueOnce(domainSnapshot(9, { home_city: "New" }));
  const older = refreshMemoryDocument({ ...readParams(), force: true });
  const newer = await refreshMemoryDocument({ ...readParams(), force: true });
  old.resolve(domainSnapshot(7, { home_city: "Old" }));
  expect((await older).status).toBe("stale");
  expect(peekMemoryView(USER).document?.markdown).toBe(
    newer.document?.markdown,
  );
});
it("teardown fences late decrypted publication", async () => {
  const old = deferred<ReturnType<typeof domainSnapshot>>();
  getStaleFirst.mockImplementationOnce(() => old.promise);
  const building = refreshMemoryDocument(readParams());
  clearMemoryDocument(USER);
  old.resolve(domainSnapshot(7, { home_city: "PRIVATE" }));
  expect((await building).status).toBe("stale");
  expect(peekMemoryView(USER).document).toBeNull();
  expect(peekLiveMirror(USER)).toBeNull();
});
it("expired session cache is stale", async () => {
  vi.useFakeTimers();
  try {
    getStaleFirst.mockResolvedValue(domainSnapshot(7, { home_city: "Old" }));
    await refreshMemoryDocument(readParams());
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(peekMemoryView(USER).status).toBe("stale");
  } finally {
    vi.useRealTimers();
  }
});

describe("persisted source-linked Profile memory.md", () => {
  function sources() {
    const verifiedAt = new Date().toISOString();
    const identity = { profile: { age: 35, sex: "female", note: "Complete eligible fact" } };
    const soul = { schema_version: "one.memory.md.v1", markdown: "# Facts\n- Owner-authored Soul fact.\n" };
    const inventory = {
      complete: true, unavailable: [], observedAt: verifiedAt,
      records: [{ kind: "profile", id: USER, revision: 2, createdAt: null, updatedAt: null,
        capturedAt: verifiedAt, deletedAt: null,
        value: { name: "Synthetic Ava", photo: "https://example.test/avatar.png", email: "synthetic@example.test" } }],
    };
    return {
      identity,
      soul,
      living: { legacy_record: { retained: "Full original source record" }, _private: {
        inventory, control: { retained: true },
      } } as Record<string, unknown>,
      identityRevision: 7,
      livingRevision: 9,
    };
  }

  function mountSources(state: ReturnType<typeof sources>) {
    getStaleFirst.mockImplementation(async ({ domain }: { domain: string }) => {
      const data = domain === "identity" ? state.identity : domain === "one_living_sources" ? state.living : state.soul;
      return { ...domainSnapshot(domain === "identity" ? state.identityRevision : state.livingRevision, data),
        manifestRevision: domain === "identity" ? 4 : 2 };
    });
    saveMergedDomain.mockImplementation(async (params) => {
      await params.beforeEffect();
      const plan = await params.build({ currentDomainData: structuredClone(state.living) });
      state.living = structuredClone(plan.domainData);
      state.livingRevision += 1;
      return { success: true };
    });
  }

  const refreshSources = (force = false) => refreshMemoryDocument({
    ...readParams(), domains: ["identity", "one_living_sources", "one_memory"], force,
  });

  it("uses existing PKM projection authority, preserves full sources and Soul, and retains exact source revisions", async () => {
    const state = sources();
    const originalSoul = structuredClone(state.soul);
    const originalInventory = structuredClone((state.living._private as Record<string, unknown>).inventory);
    mountSources(state);
    const view = await refreshSources();
    expect(view.status).toBe("current");
    expect(saveMergedDomain).toHaveBeenCalledTimes(1);
    const save = saveMergedDomain.mock.calls[0]![0];
    expect(save.domain).toBe("one_living_sources");
    expect(save.confirmation).toEqual({ authorizationMode: "owner_source_projection", surface: "web", source: "one_living_memory_source_projection" });
    expect(save.idempotencyScope).toMatch(/^memory_document:[a-f0-9]{64}$/);
    expect(state.soul).toEqual(originalSoul);
    expect(state.living.legacy_record).toEqual({ retained: "Full original source record" });
    const privateData = state.living._private as Record<string, unknown>;
    expect(privateData.inventory).toEqual(originalInventory);
    expect(privateData.control).toEqual({ retained: true });
    const persisted = privateData.memory_document as { schemaVersion: string; name: string; document: typeof view.document };
    expect(persisted.schemaVersion).toBe("source_linked_memory.v1");
    expect(persisted.name).toBe("memory.md");
    expect(persisted.document).toEqual(view.document);
    expect(view.document?.markdown).toContain("Synthetic Ava");
    expect(view.document?.markdown).toContain("https://example.test/avatar.png");
    expect(view.document?.markdown).toContain("female");
    expect(view.document?.markdown).toContain("Complete eligible fact");
    expect(view.document?.markdown).not.toContain("Owner-authored Soul fact");
    expect(view.document?.sourceLinks).toEqual(expect.arrayContaining([
      { domain: "identity", path: "profile.sex", contentRevision: 7, manifestRevision: 4 },
      { domain: "account_profile", path: "photoUrl", contentRevision: null, manifestRevision: null },
    ]));
    expect(retrieveApprovedMemoryScopes).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER, ownerIdentity: expect.objectContaining({ displayName: "Synthetic Ava", photoUrl: "https://example.test/avatar.png" }),
      approvedScopes: expect.arrayContaining(["attr.identity.identity_profile.full_name", "attr.identity.identity_profile.declared_age"]),
    }));
  });

  it("shows corrected facts, conflicts and tombstones in private memory without publishing an unresolved view", async () => {
    const state = sources();
    mountSources(state);
    await refreshSources();
    let inventory = (state.living._private as Record<string, unknown>).inventory as {
      observedAt: string;
      records: { id: string; revision: number; capturedAt: string; deletedAt: string | null; value: Record<string, unknown> }[];
    };
    let profile = inventory.records[0]!;
    profile.revision += 1;
    profile.value.name = "Ankit";
    profile.capturedAt = inventory.observedAt = new Date().toISOString();
    state.livingRevision += 1;
    const corrected = await refreshSources(true);
    expect(corrected.status).toBe("current");
    expect(corrected.document?.markdown).toContain("profile.name · verified");
    expect(corrected.document?.markdown).toContain("Ankit");
    expect(corrected.document?.markdown).not.toContain("Synthetic Ava");
    const lastComplete = structuredClone((state.living._private as Record<string, unknown>).memory_document);

    inventory = (state.living._private as Record<string, unknown>).inventory as typeof inventory;
    profile = inventory.records[0]!;
    inventory.records.push({ ...profile, value: { ...profile.value, name: "Contradictory name" } });
    state.livingRevision += 1;
    const conflict = await refreshSources(true);
    expect(conflict.status).toBe("refresh_failed");
    // The incomplete document must not hide a conflict behind "Some sources unavailable".
    expect(peekLiveMirror(USER)?.overall).toBe("conflict");
    expect(conflict.document?.markdown).toContain("profile.__record · conflicted");
    expect(conflict.document?.markdown).toContain("Unresolved source conflict");
    expect(conflict.document?.markdown).not.toContain("## Account");
    expect((state.living._private as Record<string, unknown>).memory_document).toEqual(lastComplete);

    inventory = (state.living._private as Record<string, unknown>).inventory as typeof inventory;
    profile = inventory.records[0]!;
    inventory.records.pop();
    profile.revision += 1;
    profile.deletedAt = profile.capturedAt = inventory.observedAt = new Date().toISOString();
    profile.value = {};
    state.livingRevision += 1;
    const deleted = await refreshSources(true);
    expect(deleted.status).toBe("current");
    expect(deleted.document?.markdown).toContain("profile.__record · deleted");
    expect(deleted.document?.markdown).not.toContain("Ankit");
  });

  it("passes both names into the mirror when the Soul disagrees with the verified profile name", async () => {
    const state = sources();
    state.soul = { ...state.soul, markdown: "# Facts\n- Preferred name: Ava S\n" };
    mountSources(state);
    expect((await refreshSources()).status).toBe("refresh_failed");
    const mirror = peekLiveMirror(USER)!;
    expect(mirror.overall).toBe("conflict");
    expect(mirror.nameConflict).toBe(true);
    const profileClaim = expect.objectContaining({ source: "profile", origin: "named", label: "Profile", value: "Synthetic Ava", revision: 2 });
    expect(mirror.conflicts).toEqual([{ predicate: "profile.name", label: "Name", claims: [
      { source: "soul", origin: "named", label: "Your memory", value: "Ava S", revision: 9, sourceUpdatedAt: null, verifiedAt: null },
      profileClaim,
    ] }]);
    expect(mirror.facts.find(fact => fact.predicate === "profile.name")).toMatchObject({ value: "Synthetic Ava", state: "verified" });
    // Every differing name the owner wrote is a side; one written like the verified name is not.
    state.soul = { ...state.soul, markdown: "# Facts\n- Display name: Ava S\n- Preferred name: Avi\n" };
    await refreshSources(true);
    expect(peekLiveMirror(USER)?.conflicts?.[0]?.claims.map(claim => claim.value)).toEqual(["Ava S", "Avi", "Synthetic Ava"]);
    // Negative controls: the same name written differently, or a deleted claim, raises nothing.
    state.soul = { ...state.soul, markdown: "# Facts\n- Preferred name:  synthetic   ava \n" };
    expect((await refreshSources(true)).status).toBe("current");
    expect(peekLiveMirror(USER)).toMatchObject({ nameConflict: false, conflicts: [] });
    state.soul = { ...state.soul, markdown: "# Facts\n- Preferred name: Ava S\n", _deleted_fact_labels: ["preferred name"] };
    expect((await refreshSources(true)).status).toBe("current");
    expect(peekLiveMirror(USER)).toMatchObject({ nameConflict: false, conflicts: [] });
  });

  it("reuses the persisted document after session cache clear and does not loop on its own PKM write revision", async () => {
    const state = sources();
    mountSources(state);
    const first = await refreshSources();
    // A source projection write advances the envelope revision, but does not
    // change any source record or permit a second recursive memory copy.
    clearMemoryDocument(USER);
    const readback = await refreshSources(true);
    expect(readback.document).toEqual(first.document);
    expect(readback.builtAt).toBe(first.builtAt);
    expect(saveMergedDomain).toHaveBeenCalledTimes(1);
    expect(readback.document?.sourceLinks.some(link => link.path.includes("memory_document"))).toBe(false);
  });

  it("replaces removed source facts on revision refresh rather than resurrecting the persisted document", async () => {
    const state = sources();
    mountSources(state);
    await refreshSources();
    state.identity = { profile: { sex: "female", note: "New eligible fact" } } as typeof state.identity;
    state.identityRevision += 1;
    const refreshed = await refreshSources(true);
    expect(saveMergedDomain).toHaveBeenCalledTimes(2);
    expect(refreshed.document?.markdown).toContain("New eligible fact");
    expect(refreshed.document?.markdown).not.toContain("Complete eligible fact");
    expect(refreshed.document?.sourceLinks.some(link => link.domain === "identity" && link.path === "profile.age")).toBe(false);
    expect(refreshed.document?.sourceLinks.find(link => link.domain === "identity" && link.path === "profile.sex")?.contentRevision).toBe(8);
  });

  it("does not persist incomplete source readback over a complete prior document", async () => {
    const state = sources();
    mountSources(state);
    await refreshSources();
    const prior = structuredClone((state.living._private as Record<string, unknown>).memory_document);
    saveMergedDomain.mockClear();
    getStaleFirst.mockImplementation(async ({ domain }: { domain: string }) => {
      if (domain === "identity") throw new Error("Source decrypt unavailable");
      return domainSnapshot(state.livingRevision, domain === "one_living_sources" ? state.living : state.soul);
    });
    const failed = await refreshSources(true);
    expect(failed.status).toBe("refresh_failed");
    expect(failed.document?.complete).toBe(false);
    expect(saveMergedDomain).not.toHaveBeenCalled();
    expect((state.living._private as Record<string, unknown>).memory_document).toEqual(prior);
  });

  it("rejects a persistence build if the source inventory changed during the coordinator read", async () => {
    const state = sources();
    mountSources(state);
    saveMergedDomain.mockImplementation(async (params) => {
      const concurrent = structuredClone(state.living);
      ((concurrent._private as Record<string, unknown>).inventory as { observedAt: string }).observedAt = "2026-10-13T01:00:00.000Z";
      expect(() => params.build({ currentDomainData: concurrent })).toThrow("Memory inventory changed");
      return { success: false };
    });
    expect((await refreshSources()).status).toBe("stale");
    expect((state.living._private as Record<string, unknown>).memory_document).toBeUndefined();
    expect(peekMemoryView(USER).document).toBeNull();
  });

  it("cancels a changed source immediately before dispatch, then allows a fresh rebuild", async () => {
    const state = sources();
    mountSources(state);
    const stop = watchMemoryFreshness(USER);
    try {
      saveMergedDomain.mockImplementationOnce(async (params) => {
        params.build({ currentDomainData: structuredClone(state.living) });
        events.listener?.({ userId: USER, domain: "identity" });
        let cancellation: unknown;
        try { await params.beforeEffect(); } catch (error) { cancellation = error; }
        expect(cancellation).toBeInstanceOf(DOMException);
        expect((cancellation as DOMException).name).toBe("AbortError");
        return { success: false, saveState: "blocked_pending_unlock" };
      });
      expect((await refreshSources()).status).toBe("stale");
      expect((state.living._private as Record<string, unknown>).memory_document).toBeUndefined();
      expect(retrieveApprovedMemoryScopes).not.toHaveBeenCalled();
      expect((await refreshSources()).status).toBe("current");
      expect((state.living._private as Record<string, unknown>).memory_document).toBeDefined();
    } finally { stop(); }
  });

  it("marks the cached document pending when concurrent inventory changed without an event", async () => {
    const state = sources();
    mountSources(state);
    await refreshSources();
    expect(peekMemoryView(USER).status).toBe("current");
    state.identity.profile.note = "Changed source fact";
    state.identityRevision += 1;
    saveMergedDomain.mockImplementationOnce(async (params) => {
      const concurrent = structuredClone(state.living);
      ((concurrent._private as Record<string, unknown>).inventory as { observedAt: string }).observedAt = "changed";
      expect(() => params.build({ currentDomainData: concurrent })).toThrow("Memory inventory changed");
      return { success: false, saveState: "blocked_pending_unlock" };
    });
    expect((await refreshSources(true)).status).toBe("stale");
    expect(peekMemoryView(USER).status).toBe("refresh_pending");
    expect((await refreshSources()).status).toBe("current");
    expect(peekMemoryView(USER).document?.markdown).toContain("Changed source fact");
  });

  it("preserves previously requested scope slices while rebuilding the shared Profile document", async () => {
    const state = sources();
    const retained = { "attr.identity.profile.sex": { scope: "attr.identity.profile.sex", payload: { profile: { sex: "female" } } } };
    (state.living._private as Record<string, unknown>).memory_document = { scopeSlices: retained };
    mountSources(state);
    await refreshSources(true);
    expect(((state.living._private as Record<string, unknown>).memory_document as { scopeSlices: unknown }).scopeSlices).toEqual(retained);
    expect(retrieveApprovedMemoryScopes).toHaveBeenCalledWith(expect.objectContaining({ approvedScopes: expect.arrayContaining(["attr.identity.profile.sex"]) }));
  });

  it("expires the Profile document at a UTC day boundary even while its revision cache is fresh", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-12T23:59:59Z"));
      const state = sources(); mountSources(state);
      await refreshSources();
      expect(peekMemoryView(USER).status).toBe("current");
      vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
      expect(peekMemoryView(USER).status).toBe("stale");
      await refreshSources();
      expect(peekMemoryView(USER).status).toBe("current");
      expect(retrieveApprovedMemoryScopes).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("stops calling the view current once a source passes its check window, without re-reading every domain", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
      mountSources(sources());
      expect((await refreshSources()).status).toBe("current");
      const reads = getStaleFirst.mock.calls.length;
      vi.setSystemTime(new Date("2026-10-15T10:06:59.000Z"));
      expect(peekMemoryView(USER).status).toBe("current");
      expect(peekLiveMirror(USER)?.overall).toBe("current");
      vi.setSystemTime(new Date("2026-10-15T10:07:01.000Z"));
      expect(peekMemoryView(USER).status).toBe("stale");
      expect(peekLiveMirror(USER)).toMatchObject({ overall: "stale", lastVerifiedAt: "2026-10-15T10:00:00.000Z" });
      // Only a source sync renews verification age; a wake that marks no
      // change must not turn age into a read of every domain.
      expect((await refreshSources()).status).toBe("stale");
      expect(getStaleFirst.mock.calls.length).toBe(reads);
      markMemoryRefreshPending(USER);
      await refreshSources();
      expect(getStaleFirst.mock.calls.length).toBe(reads * 2);
    } finally { vi.useRealTimers(); }
  });

  it("uses this owner session's profile check time, never another owner's or vault epoch's", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
      mountSources(sources());
      vi.setSystemTime(new Date("2026-10-15T10:05:00.000Z"));
      const sessionCheck = "2026-10-15T10:04:00.000Z";
      const profileCheck = () => peekLiveMirror(USER)?.sources.find(source => source.id === "living:profile")?.verifiedAt;
      recordLivingSourceSessionVerification("owner-b", snapshotVaultSessionEpoch(), ["profile"], sessionCheck);
      recordLivingSourceSessionVerification(USER, snapshotVaultSessionEpoch() + 1, ["profile"], sessionCheck);
      await refreshSources(true);
      expect(profileCheck()).toBe("2026-10-15T10:00:00.000Z");
      recordLivingSourceSessionVerification(USER, snapshotVaultSessionEpoch(), ["profile"], sessionCheck);
      // An unchanged sync rebuilds nothing; its check time applies on read.
      expect(profileCheck()).toBe(sessionCheck);
      await refreshSources(true);
      expect(profileCheck()).toBe(sessionCheck);
    } finally { vi.useRealTimers(); }
  });

  it("shows checked sources and marks the failed one, without persisting or rebuilding paid slices", async () => {
    const state = sources();
    const inventory = (state.living._private as Record<string, unknown>).inventory as Record<string, unknown>;
    const lastCheck = new Date(Date.now() - 60_000).toISOString();
    Object.assign(inventory, {
      complete: false, unavailable: ["consent"], verifiedAt: { consent: lastCheck },
      records: [...(inventory.records as unknown[]), { kind: "consent", id: "c1", revision: 1, createdAt: null, updatedAt: null,
        capturedAt: lastCheck, deletedAt: null, value: { scope: "attr.food.*", status: "active" } }],
    });
    mountSources(state);
    const view = await refreshSources();
    expect(view.status).toBe("refresh_failed");
    expect(saveMergedDomain).not.toHaveBeenCalled();
    expect(retrieveApprovedMemoryScopes).not.toHaveBeenCalled();
    // The incomplete inventory feeds only the mirror, never the legacy document.
    expect(view.document?.markdown).not.toContain("Synthetic Ava");
    const mirror = peekLiveMirror(USER)!;
    expect(mirror.overall).toBe("partial");
    expect(mirror.sources.find(source => source.id === "living:consent")).toMatchObject({ state: "unavailable", verifiedAt: lastCheck });
    expect(mirror.sources.find(source => source.id === "living:profile")?.state).toBe("current");
    expect(mirror.facts.find(fact => fact.predicate === "consent.scope")).toMatchObject({ value: "attr.food.*", state: "unavailable" });
    expect(mirror.facts.find(fact => fact.predicate === "profile.name")).toMatchObject({ value: "Synthetic Ava", state: "verified" });

    Object.assign(inventory, { complete: true, unavailable: [] });
    state.livingRevision += 1;
    await refreshSources(true);
    expect(peekLiveMirror(USER)?.sources.find(source => source.id === "living:consent")?.state).toBe("current");
  });
});

it("persisting derived memory cannot perpetually mark its source document stale", async () => {
  const stop = watchMemoryFreshness(USER);
  try {
    getStaleFirst.mockResolvedValue(domainSnapshot(7, { home_city: "Synthetic city" }));
    await refreshMemoryDocument({ userId: USER, vaultKey: "key", vaultOwnerToken: "token", domains: ["personal_data"] });
    events.listener?.({ userId: USER, domain: "one_living_sources", operation: "stored" });
    expect(peekMemoryView(USER).status).toBe("current");
    events.listener?.({ userId: USER, domain: "personal_data", operation: "stored" });
    expect(peekMemoryView(USER).status).toBe("refresh_pending");
  } finally { stop(); }
});

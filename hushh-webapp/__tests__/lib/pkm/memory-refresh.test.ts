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
    null | ((detail: { userId: string; domain: string }) => void),
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
  peekMemoryView,
  refreshMemoryDocument,
} from "@/lib/pkm/memory-refresh";

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

  it("clearing on lock drops the document back to stale", async () => {
    getStaleFirst.mockResolvedValue(
      domainSnapshot(7, { home_city: "Bengaluru" }),
    );
    await refreshMemoryDocument({
      userId: USER,
      vaultKey: "key",
      vaultOwnerToken: "token",
      domains: ["personal_data"],
    });
    clearMemoryDocument(USER);
    expect(peekMemoryView(USER)).toEqual({
      document: null,
      status: "stale",
      builtAt: null,
    });
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
    const identity = { profile: { age: 35, sex: "female", note: "Complete eligible fact" } };
    const soul = { schema_version: "one.memory.md.v1", markdown: "# Facts\n- Owner-authored Soul fact.\n" };
    const inventory = {
      complete: true, unavailable: [], observedAt: "2026-10-13T00:00:00.000Z",
      records: [{ kind: "profile", id: USER, revision: 2, createdAt: null, updatedAt: null,
        capturedAt: "2026-10-13T00:00:00.000Z", deletedAt: null,
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
    await expect(refreshSources()).rejects.toThrow("Encrypted memory document could not be stored");
    expect((state.living._private as Record<string, unknown>).memory_document).toBeUndefined();
    expect(peekMemoryView(USER).document).toBeNull();
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
});

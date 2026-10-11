import { beforeEach, describe, expect, it, vi } from "vitest";

const getStaleFirst = vi.fn();
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

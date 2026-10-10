import { beforeEach, describe, expect, it, vi } from "vitest";

const getStaleFirst = vi.fn();
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { getStaleFirst: (...args: unknown[]) => getStaleFirst(...args) },
}));
vi.mock("@/lib/pkm/pkm-domain-change-events", () => ({
  subscribeToPkmDomainChanges: () => () => {},
}));

import {
  clearMemoryDocument,
  peekMemoryView,
  refreshMemoryDocument,
} from "@/lib/pkm/memory-refresh";

const USER = "owner-1";

const domainSnapshot = (contentRevision: number, data: Record<string, unknown>) => ({
  key: { userId: USER, domain: "personal_data", segmentIds: [], contentRevision },
  data,
  manifestRevision: 1,
  updatedAt: "2026-10-01T00:00:00.000Z",
  audit: { cacheTier: "memory", source: "network", refreshedAt: "2026-10-01T00:00:00.000Z" },
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
    getStaleFirst.mockResolvedValue(domainSnapshot(7, { home_city: "Bengaluru" }));
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
    getStaleFirst.mockResolvedValue(domainSnapshot(7, { home_city: "Bengaluru" }));
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
    getStaleFirst.mockResolvedValue(domainSnapshot(7, { home_city: "Bengaluru" }));
    await refreshMemoryDocument({
      userId: USER,
      vaultKey: "key",
      vaultOwnerToken: "token",
      domains: ["personal_data"],
    });
    clearMemoryDocument(USER);
    expect(peekMemoryView(USER)).toEqual({ document: null, status: "stale", builtAt: null });
  });
});

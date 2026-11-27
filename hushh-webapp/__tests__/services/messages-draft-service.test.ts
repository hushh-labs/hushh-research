import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { MessagesDraftService as Drafts } from "@/lib/services/messages-draft-service";
import { openSecureResourceDb, SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";
import { SecureDurableResourceService } from "@/lib/services/secure-durable-resource-service";

const OWNER = "draft-owner-a";
const OTHER = "draft-owner-b";
const KEY = "ab".repeat(32);
const scope = "people:person-a";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([Drafts.clearForUser(OWNER), Drafts.clearForUser(OTHER)]);
});

it("recovers encrypted unsent text only for its owner and exact destination", async () => {
  const session = Drafts.session(OWNER);
  await Drafts.write(session, scope, KEY, "private unsent words", null);
  expect(await Drafts.read(session, scope, KEY, null)).toBe("private unsent words");
  expect(await Drafts.read(Drafts.session(OTHER), scope, KEY, null)).toBeNull();
  expect(await Drafts.read(session, "people:person-b", KEY, null)).toBeNull();
  const db = await openSecureResourceDb();
  try {
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const request = db!.transaction("resource_cache").objectStore("resource_cache").index("userId").getAll(OWNER);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("private unsent words");
    expect(JSON.stringify(rows)).not.toContain(KEY);
  } finally { db?.close(); }
});

it("rejects a previous Circle membership and retires its old checkpoint", async () => {
  const session = Drafts.session(OWNER);
  await Drafts.write(session, "circle:a", KEY, "before leaving", "joined-one");
  expect(await Drafts.read(session, "circle:a", KEY, "joined-two")).toBeNull();
  expect(await Drafts.read(session, "circle:a", KEY, "joined-one")).toBeNull();
});

it("removes the recovery draft before an uncertain send can be replayed", async () => {
  const session = Drafts.session(OWNER);
  await Drafts.write(session, scope, KEY, "send once", null);
  await Drafts.remove(session, scope);
  expect(await Drafts.read(Drafts.session(OWNER), scope, KEY, null)).toBeNull();
});

it("serializes logout after in-flight encryption and fences old writers on re-login", async () => {
  const started = deferred(), release = deferred();
  const original = SecureResourceCacheService.writeRequired.bind(SecureResourceCacheService);
  vi.spyOn(SecureResourceCacheService, "writeRequired").mockImplementation(async params => {
    started.resolve(); await release.promise; return original(params);
  });
  const oldSession = Drafts.session(OWNER);
  const write = Drafts.write(oldSession, scope, KEY, "must leave with logout", null);
  await started.promise;
  const clearing = Drafts.clearForUser(OWNER);
  const reopened = Drafts.read(Drafts.session(OWNER), scope, KEY, null);
  release.resolve();
  await Promise.all([write, clearing]);
  expect(await reopened).toBeNull();
  await Drafts.write(oldSession, scope, KEY, "late old account result", null);
  expect(await Drafts.read(Drafts.session(OWNER), scope, KEY, null)).toBeNull();
});

it("does not resurrect a checkpoint after the account Reset generation changes", async () => {
  const started = deferred(), release = deferred();
  const original = SecureResourceCacheService.writeRequired.bind(SecureResourceCacheService);
  vi.spyOn(SecureResourceCacheService, "writeRequired").mockImplementation(async params => {
    started.resolve(); await release.promise; return original(params);
  });
  const session = Drafts.session(OWNER);
  const write = Drafts.write(session, scope, KEY, "old generation", null);
  const rejected = expect(write).rejects.toBeDefined();
  await started.promise;
  await SecureDurableResourceService.purgeUser(OWNER);
  release.resolve();
  await rejected;
  expect(await Drafts.read(session, scope, KEY, null)).toBeNull();
});

it("vault lock retires plaintext operations but preserves sealed recovery for the next unlock", async () => {
  const oldSession = Drafts.session(OWNER);
  await Drafts.write(oldSession, scope, KEY, "sealed before lock", null);
  Drafts.lock(OWNER);
  expect(await Drafts.read(oldSession, scope, KEY, null)).toBeNull();
  await Drafts.write(oldSession, scope, KEY, "stale unlocked editor", null);
  expect(await Drafts.read(Drafts.session(OWNER), scope, KEY, null)).toBe("sealed before lock");
});

it("accepts the exact text boundary and refuses oversized recovery values", async () => {
  const session = Drafts.session(OWNER);
  await Drafts.write(session, scope, KEY, "a".repeat(4000), null);
  await Drafts.write(session, scope, KEY, "b".repeat(4001), null);
  expect(await Drafts.read(session, scope, KEY, null)).toBe("a".repeat(4000));
});

it("refuses send retirement if vault lock invalidated its queued session", async () => {
  const session = Drafts.session(OWNER);
  await Drafts.write(session, scope, KEY, "keep sealed", null);
  const started = deferred(), release = deferred();
  const original = SecureResourceCacheService.read.bind(SecureResourceCacheService);
  const spy = vi.spyOn(SecureResourceCacheService, "read").mockImplementation(async params => {
    started.resolve(); await release.promise; return original(params);
  });
  const reading = Drafts.read(session, scope, KEY, null);
  await started.promise;
  const removal = Drafts.remove(session, scope);
  const rejected = expect(removal).rejects.toThrow("draft changed");
  Drafts.lock(OWNER);
  release.resolve();
  await reading; await rejected;
  spy.mockRestore();
  expect(await Drafts.read(Drafts.session(OWNER), scope, KEY, null)).toBe("keep sealed");
});

it("an old inactive editor cannot overwrite newer typing after retirement", async () => {
  const session = Drafts.session(OWNER);
  await Drafts.write(session, scope, KEY, "old text", null);
  const retired = await Drafts.remove(session, scope);
  await Drafts.write(session, scope, KEY, "new editor text", null);
  expect(await Drafts.write(session, scope, KEY, "old text", null, retired)).toBe(false);
  expect(await Drafts.read(session, scope, KEY, null)).toBe("new editor text");
});

it("blocks recovery after failed logout purge until strict cleanup succeeds", async () => {
  await Drafts.write(Drafts.session(OWNER), scope, KEY, "must be purged", null);
  vi.spyOn(SecureResourceCacheService, "invalidateResourcePrefixRequired").mockRejectedValueOnce(new Error("storage blocked"));
  await expect(Drafts.clearForUser(OWNER)).rejects.toThrow("storage blocked");
  const session = Drafts.session(OWNER);
  expect(await Drafts.read(session, scope, KEY, null)).toBeNull();
  expect(await Drafts.write(session, scope, KEY, "blocked writer", null)).toBe(false);
  await Drafts.clearForUser(OWNER);
  expect(await Drafts.read(Drafts.session(OWNER), scope, KEY, null)).toBeNull();
});

import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecoveryCheckpointUnreadableError } from "@/lib/services/recovery-checkpoint-error";
import { openSecureResourceDb, SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";

const USER_ID = "uid-secure-cache";
const VAULT_KEY = "ab".repeat(32);

async function readRawCacheRecord(): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    // No explicit version: open whatever the service last created, so a schema
    // bump does not silently turn this raw read into a VersionError.
    const request = indexedDB.open("hushh-secure-resource-cache");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("resource_cache", "readonly");
      const get = transaction.objectStore("resource_cache").get(
        `${USER_ID}:migration:test`,
      );
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        resolve(get.result ?? null);
        database.close();
      };
    };
  });
}

afterEach(async () => {
  // The service retains its open connection. Deleting the whole database
  // between tests blocks the next open behind that connection.
  await SecureResourceCacheService.invalidateUser(USER_ID);
});

describe("SecureResourceCacheService.writeRequired", () => {
  it.each([
    ["local_device_keys", "onboarding_buffer"],
    ["durable_resources", "owner_generations"],
  ])("upgrades either shipped v2 layout without losing ciphertext (%s)", async (...stores) => {
    const factory = new IDBFactory();
    const retained = { key: "opaque-existing-record", payload: "sealed-existing-ciphertext" };
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("hushh-secure-resource-cache", 2);
      request.onupgradeneeded = () => {
        const cache = request.result.createObjectStore("resource_cache", { keyPath: "key" });
        cache.createIndex("userId", "userId");
        cache.put(retained);
        for (const store of stores) request.result.createObjectStore(store);
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    vi.stubGlobal("indexedDB", factory);
    let database: IDBDatabase | null = null;
    try {
      database = await openSecureResourceDb();
      expect(database).not.toBeNull();
      expect(Array.from(database!.objectStoreNames)).toEqual([
        "durable_resources", "local_device_keys", "onboarding_buffer", "owner_generations", "resource_cache",
      ]);
      const record = await new Promise((resolve, reject) => {
        const request = database!.transaction("resource_cache").objectStore("resource_cache").get(retained.key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(record).toEqual(retained);
    } finally {
      database?.close();
      vi.unstubAllGlobals();
    }
  });
  it("discovers only the owner's encrypted recovery keys and observes durable cleanup", async () => {
    const params = { userId: USER_ID, resourceKey: "migration:test", vaultKey: VAULT_KEY };
    await SecureResourceCacheService.writeRequired({ ...params, value: { fact: "Synthetic private fact" }, ttlMs: 60_000 });
    expect(await SecureResourceCacheService.listResourceKeys("different-owner", "migration:")).toEqual([]);
    expect(await SecureResourceCacheService.listResourceKeys(USER_ID, "unrelated:")).toEqual([]);
    expect(await SecureResourceCacheService.listResourceKeys(USER_ID, "migration:")).toEqual(["migration:test"]);
    expect(JSON.stringify(await readRawCacheRecord())).not.toContain("Synthetic private fact");
    await SecureResourceCacheService.invalidateResourceRequired(USER_ID, "migration:test");
    expect(await SecureResourceCacheService.readRequired(params)).toBeNull();
  });
  it("recovery reads distinguish absence from failed decryption without deleting ciphertext", async () => {
    const params = { userId: USER_ID, resourceKey: "migration:test", vaultKey: VAULT_KEY };
    await expect(SecureResourceCacheService.readRequired(params)).resolves.toBeNull();
    await SecureResourceCacheService.writeRequired({ ...params, value: { revision: "synthetic-recovery" }, ttlMs: 60_000 });
    // Recovery may step past a checkpoint that can never be read, so the reason is typed.
    await expect(SecureResourceCacheService.readRequired({ ...params, vaultKey: "cd".repeat(32) }))
      .rejects.toMatchObject({ name: "RecoveryCheckpointUnreadableError", reason: "unreadable" });
    await expect(SecureResourceCacheService.readRequired(params)).resolves.toEqual({ revision: "synthetic-recovery" });
  });
  it("expired recovery stays encrypted rather than becoming a new absent job", async () => {
    const params = { userId: USER_ID, resourceKey: "migration:test", vaultKey: VAULT_KEY };
    await SecureResourceCacheService.writeRequired({ ...params, value: { revision: "synthetic-recovery" }, ttlMs: -1 });
    const expired = await SecureResourceCacheService.readRequired(params).catch((error: unknown) => error);
    expect(expired).toBeInstanceOf(RecoveryCheckpointUnreadableError);
    expect(expired).toMatchObject({ reason: "expired", message: expect.stringContaining("needs review") });
    expect(await readRawCacheRecord()).not.toBeNull();
  });
  it("keeps a checkpoint written ahead of this device's clock retryable", async () => {
    const params = { userId: USER_ID, resourceKey: "migration:test", vaultKey: VAULT_KEY };
    await SecureResourceCacheService.writeRequired({ ...params, value: { revision: "synthetic-recovery" }, ttlMs: 60_000 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 60 * 60_000);
    const behind = await SecureResourceCacheService.readRequired(params).catch((error: unknown) => error);
    vi.useRealTimers();
    // The clock catches up, so recovery must retry it rather than hold it.
    expect(behind).toBeInstanceOf(Error);
    expect(behind).not.toBeInstanceOf(RecoveryCheckpointUnreadableError);
    expect(await readRawCacheRecord()).not.toBeNull();
  });
  it("commits an encrypted record before callers retire a legacy source", async () => {
    const value = {
      source: "pre_vault_onboarding",
      selection: "long_term",
    };

    await SecureResourceCacheService.writeRequired({
      userId: USER_ID,
      resourceKey: "migration:test",
      value,
      ttlMs: 60_000,
      vaultKey: VAULT_KEY,
    });

    const raw = JSON.stringify(await readRawCacheRecord());
    expect(raw).not.toContain("long_term");
    await expect(
      SecureResourceCacheService.read<typeof value>({
        userId: USER_ID,
        resourceKey: "migration:test",
        vaultKey: VAULT_KEY,
      }),
    ).resolves.toEqual(value);
  });
});

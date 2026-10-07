import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";

const USER_ID = "uid-secure-cache";
const VAULT_KEY = "ab".repeat(32);

async function readRawCacheRecord(): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open("hushh-secure-resource-cache", 1);
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
  it("recovery reads distinguish absence from failed decryption without deleting ciphertext", async () => {
    const params = { userId: USER_ID, resourceKey: "migration:test", vaultKey: VAULT_KEY };
    await expect(SecureResourceCacheService.readRequired(params)).resolves.toBeNull();
    await SecureResourceCacheService.writeRequired({ ...params, value: { revision: "synthetic-recovery" }, ttlMs: 60_000 });
    await expect(SecureResourceCacheService.readRequired({ ...params, vaultKey: "cd".repeat(32) })).rejects.toThrow();
    await expect(SecureResourceCacheService.readRequired(params)).resolves.toEqual({ revision: "synthetic-recovery" });
  });
  it("expired recovery stays encrypted rather than becoming a new absent job", async () => {
    const params = { userId: USER_ID, resourceKey: "migration:test", vaultKey: VAULT_KEY };
    await SecureResourceCacheService.writeRequired({ ...params, value: { revision: "synthetic-recovery" }, ttlMs: -1 });
    await expect(SecureResourceCacheService.readRequired(params)).rejects.toThrow("needs review");
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

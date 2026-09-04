import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";

const USER_ID = "uid-secure-cache";
const VAULT_KEY = "ab".repeat(32);

function deleteSecureCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("hushh-secure-resource-cache");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

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
  await deleteSecureCache();
});

describe("SecureResourceCacheService.writeRequired", () => {
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

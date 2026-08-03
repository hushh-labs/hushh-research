import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalDeviceKeyService,
  OnboardingBufferService,
} from "@/lib/services/secure-resource-cache-service";

const DB_NAME = "hushh-secure-resource-cache";
const BUFFER_STORE = "onboarding_buffer";
const USER_A = "uid-buffer-a";
const USER_B = "uid-buffer-b";

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

/**
 * Read straight out of IndexedDB, bypassing the service entirely. Asserting on
 * what a wrapper returns proves nothing about what is on disk.
 */
function readRawBufferRows(): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(BUFFER_STORE, "readonly");
      const getAll = transaction.objectStore(BUFFER_STORE).getAll();
      getAll.onerror = () => reject(getAll.error);
      getAll.onsuccess = () => {
        resolve((getAll.result as Record<string, unknown>[]) ?? []);
        database.close();
      };
    };
  });
}

afterEach(async () => {
  await deleteDb();
});

describe("OnboardingBufferService — user-scoped local buffer (D1)", () => {
  it("binds every record to the Firebase UID so a shared device cannot cross accounts", async () => {
    await OnboardingBufferService.put({
      userId: USER_A,
      recordId: "rec-1",
      domain: "kai_preferences",
      value: { investment_horizon: "long_term" },
    });
    await OnboardingBufferService.put({
      userId: USER_B,
      recordId: "rec-1",
      domain: "kai_preferences",
      value: { investment_horizon: "short_term" },
    });

    const forA = await OnboardingBufferService.list<{ investment_horizon: string }>(USER_A);
    const forB = await OnboardingBufferService.list<{ investment_horizon: string }>(USER_B);

    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0]?.value.investment_horizon).toBe("long_term");
    expect(forB[0]?.value.investment_horizon).toBe("short_term");

    // Same recordId, two accounts, two distinct primary keys.
    const raw = await readRawBufferRows();
    expect(raw.map((row) => row.key).sort()).toEqual([
      `${USER_A}:rec-1`,
      `${USER_B}:rec-1`,
    ]);
  });

  it("clears only the owning account's rows", async () => {
    await OnboardingBufferService.put({
      userId: USER_A,
      recordId: "rec-1",
      domain: "kai_preferences",
      value: { a: 1 },
    });
    await OnboardingBufferService.put({
      userId: USER_B,
      recordId: "rec-2",
      domain: "kai_preferences",
      value: { b: 2 },
    });

    await OnboardingBufferService.clearUser(USER_A);

    expect(await OnboardingBufferService.count(USER_A)).toBe(0);
    expect(await OnboardingBufferService.count(USER_B)).toBe(1);
  });

  it("removes exactly one acknowledged record and leaves the rest", async () => {
    await OnboardingBufferService.put({
      userId: USER_A,
      recordId: "rec-1",
      domain: "kai_preferences",
      value: { a: 1 },
    });
    await OnboardingBufferService.put({
      userId: USER_A,
      recordId: "rec-2",
      domain: "kai_preferences",
      value: { b: 2 },
    });

    await OnboardingBufferService.remove(USER_A, "rec-1");

    const remaining = await OnboardingBufferService.list(USER_A);
    expect(remaining.map((record) => record.recordId)).toEqual(["rec-2"]);
  });
});

describe("Local device key — non-extractable, zero interaction (D2)", () => {
  it("generates one non-extractable AES-GCM key per user and reuses it", async () => {
    const first = await LocalDeviceKeyService.ensure(USER_A);
    const second = await LocalDeviceKeyService.ensure(USER_A);

    expect(first).not.toBeNull();
    expect(first?.extractable).toBe(false);
    expect((first?.algorithm as AesKeyAlgorithm)?.name).toBe("AES-GCM");
    expect((first?.algorithm as AesKeyAlgorithm)?.length).toBe(256);

    // IndexedDB hands back a structural clone, so identity says nothing. What
    // matters is that the persisted key is the SAME key: ciphertext written on
    // the first call must open on the second, and must not open for another
    // account.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      first as CryptoKey,
      new TextEncoder().encode("same-key-probe"),
    );
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      second as CryptoKey,
      sealed,
    );
    expect(new TextDecoder().decode(opened)).toBe("same-key-probe");

    const other = await LocalDeviceKeyService.ensure(USER_B);
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, other as CryptoKey, sealed),
    ).rejects.toThrow();
  });

  it("cannot be exported, so the raw key never leaves the browser", async () => {
    const key = await LocalDeviceKeyService.ensure(USER_A);
    expect(key).not.toBeNull();
    await expect(crypto.subtle.exportKey("raw", key as CryptoKey)).rejects.toThrow();
  });

  it("stores ciphertext, not plaintext — asserted on the raw IndexedDB row", async () => {
    await OnboardingBufferService.put({
      userId: USER_A,
      recordId: "rec-secret",
      domain: "kai_preferences",
      value: { note: "SENSITIVE-MARKER-VALUE", horizon: "long_term" },
    });

    const rows = await readRawBufferRows();
    expect(rows).toHaveLength(1);

    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain("SENSITIVE-MARKER-VALUE");
    expect(serialized).not.toContain("long_term");

    const payload = rows[0]?.payload as {
      ciphertext: string;
      iv: string;
      tag: string;
      algorithm: string;
    };
    expect(payload.algorithm).toBe("aes-256-gcm");
    expect(payload.ciphertext.length).toBeGreaterThan(0);
    expect(payload.iv.length).toBeGreaterThan(0);
    expect(payload.tag.length).toBeGreaterThan(0);

    // And it still round-trips for the owner.
    const restored = await OnboardingBufferService.list<{ note: string }>(USER_A);
    expect(restored[0]?.value.note).toBe("SENSITIVE-MARKER-VALUE");
  });
});

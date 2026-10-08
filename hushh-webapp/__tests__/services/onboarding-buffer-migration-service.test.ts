import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: vi.fn(),
  },
}));

import {
  applyBufferedRecordToDomain,
  migrateOnboardingBuffer,
  ONBOARDING_CAPTURE_IDS_KEY,
} from "@/lib/services/onboarding-buffer-migration-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { OnboardingBufferService } from "@/lib/services/secure-resource-cache-service";

const DB_NAME = "hushh-secure-resource-cache";
const BUFFER_STORE = "onboarding_buffer";
const USER_ID = "uid-migration";
const DOMAIN = "kai_preferences";
const VAULT_KEY = "ab".repeat(32);
const OWNER_TOKEN = "vault-owner-token";

const saveMergedDomain = vi.mocked(PkmWriteCoordinator.saveMergedDomain);

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

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

/**
 * A stand-in PKM domain that behaves the way the real one does for our
 * purposes: it holds the last written blob and re-serves it as
 * `currentDomainData` on the next write, so the capture-id set accumulates
 * across calls exactly as it would server-side.
 */
function installServerDouble(options?: { failFirstNCalls?: number }) {
  const domains = new Map<string, Record<string, unknown>>();
  let remainingFailures = options?.failFirstNCalls ?? 0;

  saveMergedDomain.mockImplementation(async (params) => {
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return {
        saveState: "failed",
        success: false,
        message: "network unavailable",
        fullBlob: {},
      };
    }
    const current = domains.get(params.domain) ?? {};
    const plan = await params.build({
      currentDomainData: current,
      currentManifest: null,
      currentEncryptedDomain: null,
      baseFullBlob: {},
      attempt: 0,
      upgradedInSession: false,
    });
    domains.set(params.domain, plan.domainData);
    return {
      saveState: "saved",
      success: true,
      dataVersion: 1,
      fullBlob: plan.domainData,
    };
  });

  return domains;
}

beforeEach(() => {
  saveMergedDomain.mockReset();
});

afterEach(async () => {
  await deleteDb();
});

describe("applyBufferedRecordToDomain — the duplicate-ID guard", () => {
  it("records each buffered id exactly once, however often it is replayed", () => {
    const once = applyBufferedRecordToDomain({
      currentDomainData: null,
      recordId: "rec-1",
      value: { horizon: "long_term" },
    });
    expect(once[ONBOARDING_CAPTURE_IDS_KEY]).toEqual(["rec-1"]);

    const twice = applyBufferedRecordToDomain({
      currentDomainData: once,
      recordId: "rec-1",
      value: { horizon: "long_term" },
    });
    expect(twice[ONBOARDING_CAPTURE_IDS_KEY]).toEqual(["rec-1"]);

    const withSecond = applyBufferedRecordToDomain({
      currentDomainData: twice,
      recordId: "rec-2",
      value: { drawdown: "stay" },
    });
    expect(withSecond[ONBOARDING_CAPTURE_IDS_KEY]).toEqual(["rec-1", "rec-2"]);
    expect(withSecond.horizon).toBe("long_term");
    expect(withSecond.drawdown).toBe("stay");
  });
});

describe("migrateOnboardingBuffer", () => {
  it("keeps records buffered as ciphertext when the write path fails", async () => {
    installServerDouble({ failFirstNCalls: 99 });

    await OnboardingBufferService.put({
      userId: USER_ID,
      recordId: "rec-1",
      domain: DOMAIN,
      value: { horizon: "OFFLINE-MARKER" },
    });

    const result = await migrateOnboardingBuffer({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: OWNER_TOKEN,
    });

    expect(result.outcome).toBe("partial");
    expect(result.acknowledgedIds).toEqual([]);
    expect(result.remainingIds).toEqual(["rec-1"]);

    // Still on disk, and still unreadable without the device key.
    const rows = await readRawBufferRows();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("OFFLINE-MARKER");
  });

  it("keeps records buffered when the PKM write throws outright", async () => {
    saveMergedDomain.mockRejectedValue(new Error("fetch failed"));

    await OnboardingBufferService.put({
      userId: USER_ID,
      recordId: "rec-1",
      domain: DOMAIN,
      value: { horizon: "long_term" },
    });

    const result = await migrateOnboardingBuffer({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: OWNER_TOKEN,
    });

    expect(result.outcome).toBe("partial");
    expect(await OnboardingBufferService.count(USER_ID)).toBe(1);
  });

  it("lands every buffered record in PKM exactly once when the network returns", async () => {
    const domains = installServerDouble({ failFirstNCalls: 2 });

    await OnboardingBufferService.put({
      userId: USER_ID,
      recordId: "rec-1",
      domain: DOMAIN,
      value: { horizon: "long_term" },
    });
    await OnboardingBufferService.put({
      userId: USER_ID,
      recordId: "rec-2",
      domain: DOMAIN,
      value: { drawdown: "stay" },
    });

    // Pass 1: both writes fail. Nothing is cleared.
    const offline = await migrateOnboardingBuffer({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: OWNER_TOKEN,
    });
    expect(offline.outcome).toBe("partial");
    expect(await OnboardingBufferService.count(USER_ID)).toBe(2);

    // Pass 2: the retry after the partial failure.
    const online = await migrateOnboardingBuffer({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: OWNER_TOKEN,
    });
    expect(online.outcome).toBe("migrated");
    expect(online.acknowledgedIds.sort()).toEqual(["rec-1", "rec-2"]);
    expect(await OnboardingBufferService.count(USER_ID)).toBe(0);

    // Pass 3: a third run must be a no-op, not a third copy.
    const again = await migrateOnboardingBuffer({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: OWNER_TOKEN,
    });
    expect(again.outcome).toBe("nothing_to_migrate");

    const stored = domains.get(DOMAIN) ?? {};
    expect(stored[ONBOARDING_CAPTURE_IDS_KEY]).toEqual(["rec-1", "rec-2"]);
    expect(stored.horizon).toBe("long_term");
    expect(stored.drawdown).toBe("stay");
  });

  it("clears a record only after the server acknowledges that specific id", async () => {
    const domains = installServerDouble();
    saveMergedDomain.mockImplementationOnce(async () => ({
      saveState: "failed",
      success: false,
      message: "network unavailable",
      fullBlob: {},
    }));

    await OnboardingBufferService.put({
      userId: USER_ID,
      recordId: "rec-1",
      domain: DOMAIN,
      value: { horizon: "long_term" },
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    await OnboardingBufferService.put({
      userId: USER_ID,
      recordId: "rec-2",
      domain: DOMAIN,
      value: { drawdown: "stay" },
      createdAt: "2026-08-02T00:00:00.000Z",
    });

    const result = await migrateOnboardingBuffer({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: OWNER_TOKEN,
    });

    expect(result.acknowledgedIds).toEqual(["rec-2"]);
    expect(result.remainingIds).toEqual(["rec-1"]);
    const remaining = await OnboardingBufferService.list(USER_ID);
    expect(remaining.map((record) => record.recordId)).toEqual(["rec-1"]);
    expect(domains.get(DOMAIN)?.[ONBOARDING_CAPTURE_IDS_KEY]).toEqual(["rec-2"]);
  });

  it("writes nothing and reports pending_vault before a vault key exists", async () => {
    installServerDouble();

    await OnboardingBufferService.put({
      userId: USER_ID,
      recordId: "rec-1",
      domain: DOMAIN,
      value: { horizon: "long_term" },
    });

    const result = await migrateOnboardingBuffer({
      userId: USER_ID,
      vaultKey: null,
      vaultOwnerToken: null,
    });

    expect(result.outcome).toBe("pending_vault");
    expect(result.remainingIds).toEqual(["rec-1"]);
    expect(saveMergedDomain).not.toHaveBeenCalled();
    expect(await OnboardingBufferService.count(USER_ID)).toBe(1);
  });

  it("stops the drain when the vault closes part-way through", async () => {
    installServerDouble();
    saveMergedDomain.mockImplementationOnce(async () => ({
      saveState: "blocked_pending_unlock",
      success: false,
      message: "Unlock your vault before saving.",
      fullBlob: {},
    }));

    await OnboardingBufferService.put({
      userId: USER_ID,
      recordId: "rec-1",
      domain: DOMAIN,
      value: { horizon: "long_term" },
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    await OnboardingBufferService.put({
      userId: USER_ID,
      recordId: "rec-2",
      domain: DOMAIN,
      value: { drawdown: "stay" },
      createdAt: "2026-08-02T00:00:00.000Z",
    });

    const result = await migrateOnboardingBuffer({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: OWNER_TOKEN,
    });

    expect(result.outcome).toBe("pending_vault");
    expect(result.remainingIds).toEqual(["rec-1", "rec-2"]);
    // Only the first record was attempted; the drain stopped rather than
    // burning a doomed write per record.
    expect(saveMergedDomain).toHaveBeenCalledTimes(1);
    expect(await OnboardingBufferService.count(USER_ID)).toBe(2);
  });

  it("returns nothing_to_migrate on an empty buffer without touching PKM", async () => {
    installServerDouble();

    const result = await migrateOnboardingBuffer({
      userId: USER_ID,
      vaultKey: VAULT_KEY,
      vaultOwnerToken: OWNER_TOKEN,
    });

    expect(result.outcome).toBe("nothing_to_migrate");
    expect(saveMergedDomain).not.toHaveBeenCalled();
  });
});

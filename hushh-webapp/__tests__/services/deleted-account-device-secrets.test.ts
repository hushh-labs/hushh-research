import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: false,
  keychainGet: vi.fn(),
  keychainDelete: vi.fn(),
  keychainDeleteBiometric: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock("@/lib/capacitor/platform", () => ({
  isNative: () => mocks.native,
}));

vi.mock("@/lib/capacitor", () => ({
  HushhKeychain: {
    get: mocks.keychainGet,
    delete: mocks.keychainDelete,
    deleteBiometric: mocks.keychainDeleteBiometric,
  },
  HushhVault: {},
}));

vi.mock("@/lib/vault/prf-auth", () => ({
  checkBrowserSupport: vi.fn(),
  checkPrfSupport: vi.fn(),
  registerWithPrf: vi.fn(),
  authenticateWithPrf: vi.fn(),
}));

vi.mock("@/lib/vault/passkey-rp", () => ({
  resolvePasskeyRpId: vi.fn(() => "one.hushh.ai"),
}));

vi.mock("@/lib/vault/passphrase-key", () => ({
  createVaultWithPassphrase: vi.fn(),
  unlockVaultWithPassphrase: vi.fn(),
}));

import { forgetLocationRecipientKey } from "@/lib/one-location/encryption";
import { VaultBootstrapService } from "@/lib/services/vault-bootstrap-service";

const DB_NAME = "hushh-one-location-keys";
const STORE_NAME = "recipientKeys";

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(STORE_NAME, { keyPath: "userId" });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
    };
  });
}

describe("deleted-account device secrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.native = false;
    mocks.keychainGet.mockResolvedValue({ value: null });
    mocks.keychainDelete.mockResolvedValue(undefined);
    mocks.keychainDeleteBiometric.mockResolvedValue(undefined);
  });

  it("removes only the deleted account's location key from IndexedDB", async () => {
    await withStore("readwrite", (store) =>
      store.put({ userId: "uid-deleted", keyId: "k1", createdAt: "now" }),
    );
    await withStore("readwrite", (store) =>
      store.put({ userId: "uid-other", keyId: "k2", createdAt: "now" }),
    );

    await forgetLocationRecipientKey("uid-deleted");

    expect(await withStore("readonly", (store) => store.get("uid-deleted"))).toBeUndefined();
    expect(await withStore("readonly", (store) => store.get("uid-other"))).toMatchObject({
      keyId: "k2",
    });
    expect(mocks.keychainDelete).not.toHaveBeenCalled();
  });

  it("also removes the native Keychain mirror and never throws", async () => {
    mocks.native = true;
    mocks.keychainDelete.mockRejectedValue(new Error("keychain locked"));

    await expect(forgetLocationRecipientKey("uid-deleted")).resolves.toBeUndefined();

    expect(mocks.keychainDelete).toHaveBeenCalledWith({
      key: "one_location_recipient_key:uid-deleted",
    });
  });

  it("removes the native quick-unlock secrets and wrapper reference", async () => {
    mocks.native = true;
    mocks.keychainGet.mockResolvedValue({ value: "wrapper-7" });

    await VaultBootstrapService.clearDeviceVaultSecretsForDeletedAccount("uid-deleted");

    expect(mocks.keychainDeleteBiometric.mock.calls.map(([options]) => options.key).sort()).toEqual([
      "vault_default_secret:uid-deleted",
      "vault_default_secret:uid-deleted:wrapper-7",
    ]);
    expect(mocks.keychainDelete).toHaveBeenCalledWith({
      key: "vault_biometric_wrapper_ref:uid-deleted",
    });
  });

  it("still removes the default secret when the wrapper reference is unreadable", async () => {
    mocks.native = true;
    mocks.keychainGet.mockRejectedValue(new Error("keychain unavailable"));
    mocks.keychainDeleteBiometric.mockRejectedValue(new Error("busy"));

    await expect(
      VaultBootstrapService.clearDeviceVaultSecretsForDeletedAccount("uid-deleted"),
    ).resolves.toBeUndefined();

    expect(mocks.keychainDeleteBiometric).toHaveBeenCalledWith({
      key: "vault_default_secret:uid-deleted",
    });
  });

  it("does nothing for vault secrets on the web", async () => {
    await VaultBootstrapService.clearDeviceVaultSecretsForDeletedAccount("uid-deleted");

    expect(mocks.keychainDeleteBiometric).not.toHaveBeenCalled();
    expect(mocks.keychainDelete).not.toHaveBeenCalled();
  });
});

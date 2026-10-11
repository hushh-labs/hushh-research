import { vi } from "vitest";
import type { VaultState } from "@/lib/services/vault-service";

const {
  mockGetIdToken,
  mockBootstrapState,
  mockHasVault,
  mockGetVault,
  mockMutation,
  mockIssueOwner,
  mockResolveRpId,
  nativePlatform,
  sessionStore,
  cacheStore,
} = vi.hoisted(() => ({
  mockGetIdToken: vi.fn(),
  mockBootstrapState: vi.fn(),
  mockHasVault: vi.fn(),
  mockGetVault: vi.fn(),
  mockMutation: vi.fn(),
  mockIssueOwner: vi.fn(),
  mockResolveRpId: vi.fn(),
  nativePlatform: { current: false },
  sessionStore: new Map<string, string>(),
  cacheStore: new Map<string, unknown>(),
}));

export { mockGetIdToken, mockBootstrapState, mockHasVault, mockGetVault, mockMutation,
  mockIssueOwner, mockResolveRpId, nativePlatform, sessionStore, cacheStore };

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => nativePlatform.current,
    getPlatform: () => (nativePlatform.current ? "ios" : "web"),
  },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhVault: {
    hasVault: mockHasVault,
    getVault: mockGetVault,
    setupVault: mockMutation,
    upsertVaultWrapper: mockMutation,
    deleteVaultWrapper: mockMutation,
    setPrimaryVaultMethod: mockMutation,
  },
  HushhAuth: {},
  HushhConsent: { issueVaultOwnerToken: mockIssueOwner },
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getIdToken: mockGetIdToken,
  },
}));

vi.mock("@/lib/firebase/config", () => ({
  auth: { currentUser: null },
}));

vi.mock("@/lib/services/cache-service", () => ({
  CacheService: {
    getInstance: () => ({
      get: (key: string) => cacheStore.get(key),
      set: (key: string, value: unknown) => cacheStore.set(key, value),
      invalidate: (key: string) => cacheStore.delete(key),
      subscribe: () => () => undefined,
    }),
  },
  CACHE_KEYS: {
    VAULT_CHECK: (userId: string) => `vault_check_${userId}`,
    PRE_VAULT_BOOTSTRAP: (userId: string) => `pre_vault_bootstrap_${userId}`,
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onVaultStateChanged: vi.fn(),
  },
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: mockBootstrapState,
  },
}));

vi.mock("@/lib/vault/passphrase-key", () => ({
  createVaultWithPassphrase: vi.fn(),
  unlockVaultWithPassphrase: vi.fn(),
  unlockVaultWithRecoveryKey: vi.fn(),
}));

vi.mock("@/lib/vault/passkey-rp", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/vault/passkey-rp")>(),
  resolvePasskeyRpId: (...args: unknown[]) => mockResolveRpId(...args),
}));

vi.mock("@/lib/services/api-client", () => ({
  apiJson: vi.fn(),
}));

vi.mock("@/lib/utils/request-timeouts", () => ({
  resolveSlowRequestTimeoutMs: (ms: number) => ms,
}));

vi.mock("@/lib/utils/session-storage", () => ({
  getLocalItem: () => null,
  getSessionItem: (key: string) => sessionStore.get(key) ?? null,
  setSessionItem: (key: string, value: string) => {
    sessionStore.set(key, value);
  },
  removeSessionItem: (key: string) => {
    sessionStore.delete(key);
  },
}));

export const wrapper = {
    method: "passphrase" as const,
    encryptedVaultKey: "encrypted",
    salt: "salt",
    iv: "iv",
  };

export function vaultMutations(service: typeof import("@/lib/services/vault-service").VaultService) {
  return [
    [
      "/api/vault/setup",
      () =>
        service.setupVaultState("mutation-user", {
          vaultKeyHash: "hash",
          primaryMethod: "passphrase",
          recoveryEncryptedVaultKey: "recovery",
          recoverySalt: "salt",
          recoveryIv: "iv",
          wrappers: [wrapper],
        }),
    ],
    [
      "/api/vault/wrapper/upsert",
      () =>
        service.upsertVaultWrapper({
          userId: "mutation-user",
          vaultKeyHash: "hash",
          wrapper,
        }),
    ],
    [
      "/api/vault/wrapper/delete",
      () =>
        service.deleteVaultWrapper({
          userId: "mutation-user",
          vaultKeyHash: "hash",
          method: "generated_default_web_prf",
          vaultOwnerToken: "owner",
        }),
    ],
    [
      "/api/vault/primary/set",
      () => service.setPrimaryVaultMethod("mutation-user", "passphrase", "default", "synthetic-owner-token"),
    ],
  ] as const;
}

export function syntheticVaultState(salt = "salt"): VaultState {
  return { vaultKeyHash: "hash", primaryMethod: "passphrase",
    recoveryEncryptedVaultKey: "recovery", recoverySalt: "salt", recoveryIv: "iv",
    wrappers: [{ ...wrapper, salt }] };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

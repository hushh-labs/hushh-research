import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetIdToken, mockBootstrapState, sessionStore } = vi.hoisted(() => ({
  mockGetIdToken: vi.fn(),
  mockBootstrapState: vi.fn(),
  sessionStore: new Map<string, string>(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhVault: {},
  HushhAuth: {},
  HushhConsent: {},
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
      get: () => undefined,
      set: () => undefined,
      invalidate: () => undefined,
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

vi.mock("@/lib/vault/passkey-rp", () => ({
  resolvePasskeyRpId: () => null,
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

import {
  VaultAuthSessionNotReadyError,
  VaultService,
} from "@/lib/services/vault-service";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("VaultService.checkVault (web) — session-restore / 401 handling", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStore.clear();
    VaultService.invalidateVaultStateCache();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("waits briefly for a still-restoring session, then fails closed instead of guessing hasVault=false", async () => {
    mockGetIdToken.mockResolvedValue(null);

    await expect(
      VaultService.checkVault("user-restoring"),
    ).rejects.toBeInstanceOf(VaultAuthSessionNotReadyError);

    // Bounded: one immediate read plus exactly one retry after the short
    // wait -- never an unbounded loop -- before giving up.
    expect(mockGetIdToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("force-refreshes the token and retries exactly once after a 401", async () => {
    mockGetIdToken.mockImplementation((forceRefresh?: boolean) =>
      Promise.resolve(forceRefresh ? "fresh-token" : "stale-token"),
    );
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }))
      .mockResolvedValueOnce(jsonResponse(200, { hasVault: true }));

    await expect(VaultService.checkVault("user-401-retry")).resolves.toBe(
      true,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(firstHeaders.Authorization).toBe("Bearer stale-token");
    expect(secondHeaders.Authorization).toBe("Bearer fresh-token");
    expect(mockGetIdToken).toHaveBeenCalledWith(true);
  });

  it("does not collapse a genuine failure into hasVault=false when no fallback state exists", async () => {
    mockGetIdToken.mockImplementation((forceRefresh?: boolean) =>
      Promise.resolve(forceRefresh ? "fresh-token" : "stale-token"),
    );
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }))
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }));
    mockBootstrapState.mockRejectedValue(new Error("backend unreachable"));

    await expect(
      VaultService.checkVault("user-genuine-failure"),
    ).rejects.toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

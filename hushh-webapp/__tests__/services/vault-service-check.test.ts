import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/vault/passkey-rp", () => ({
  isPasskeyRpIdCompatibleWithHost: (
    hostname: string | null | undefined,
    rpId: string | null | undefined,
  ) => {
    const normalizedHost = hostname?.trim().toLowerCase();
    const normalizedRpId = rpId?.trim().toLowerCase();
    return !!normalizedHost && !!normalizedRpId && (
      normalizedHost === normalizedRpId ||
      normalizedHost.endsWith(`.${normalizedRpId}`)
    );
  },
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

import {
  VaultAuthSessionNotReadyError,
  VaultService,
  type VaultState,
} from "@/lib/services/vault-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { apiJson } from "@/lib/services/api-client";
import { unlockVaultWithPassphrase } from "@/lib/vault/passphrase-key";

describe("VaultService owner renewal transport", () => {
  it("threads prior evidence to the native plugin", async () => {
    nativePlatform.current = true;
    mockIssueOwner.mockResolvedValue({ token: "synthetic-renewed", expiresAt: Date.now() + 60_000 });
    await VaultService.issueVaultOwnerToken("synthetic-owner", "synthetic-firebase", "synthetic-prior");
    expect(mockIssueOwner).toHaveBeenCalledWith({
      userId: "synthetic-owner", authToken: "synthetic-firebase", renewalOfToken: "synthetic-prior",
    });
    nativePlatform.current = false;
  });

  it("threads prior evidence to the web proxy", async () => {
    nativePlatform.current = false;
    await VaultService.issueVaultOwnerToken("synthetic-owner", "synthetic-firebase", "synthetic-prior");
    expect(apiJson).toHaveBeenCalledWith("/api/consent/vault-owner-token", expect.objectContaining({
      body: JSON.stringify({ userId: "synthetic-owner", renewalOfToken: "synthetic-prior" }),
    }));
  });
});

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

  it.each([false, true])("does not send metadata without a ready token (native=%s)", async (native) => {
    nativePlatform.current = native;
    mockGetIdToken.mockResolvedValue(null);
    await expect(VaultService.getVaultState(`token-not-ready-${native}`)).rejects.toBeInstanceOf(VaultAuthSessionNotReadyError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGetVault).not.toHaveBeenCalled();
  });

  const wrapper = {
    method: "passphrase" as const,
    encryptedVaultKey: "encrypted",
    salt: "salt",
    iv: "iv",
  };
  const mutations = [
    [
      "/api/vault/setup",
      () =>
        VaultService.setupVaultState("mutation-user", {
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
        VaultService.upsertVaultWrapper({
          userId: "mutation-user",
          vaultKeyHash: "hash",
          wrapper,
        }),
    ],
    [
      "/api/vault/wrapper/delete",
      () =>
        VaultService.deleteVaultWrapper({
          userId: "mutation-user",
          vaultKeyHash: "hash",
          method: "generated_default_web_prf",
          vaultOwnerToken: "owner",
        }),
    ],
    [
      "/api/vault/primary/set",
      () => VaultService.setPrimaryVaultMethod("mutation-user", "passphrase", "default", "synthetic-owner-token"),
    ],
  ] as const;

  describe.each([false, true])("terminal mutations, native=%s", (native) => {
    it.each(mutations)(
      "invalidates the owner after %s returns account-not-found",
      async (path, mutation) => {
        nativePlatform.current = native;
        publishValidatedAuthSessionOwner("mutation-user");
        mockGetIdToken.mockResolvedValue("token");
        mockMutation.mockRejectedValue({ code: "AUTH_ACCOUNT_NOT_FOUND" });
        fetchMock.mockResolvedValue(
          jsonResponse(401, { detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }),
        );
        const listener = vi.fn();
        window.addEventListener("auth-session-invalidated", listener);
        try {
          await expect(mutation()).rejects.toMatchObject({
            code: "AUTH_ACCOUNT_NOT_FOUND",
          });
          expect(listener).toHaveBeenCalledTimes(1);
          expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
            code: "account_not_found",
            userId: "mutation-user",
            path,
          });
        } finally {
          window.removeEventListener("auth-session-invalidated", listener);
        }
      },
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRpId.mockReturnValue(null);
    nativePlatform.current = false;
    sessionStore.clear();
    cacheStore.clear();
    publishValidatedAuthSessionOwner(null);
    VaultService.invalidateVaultStateCache();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("selects a canonical RP wrapper on a hosted subdomain", () => {
    mockResolveRpId.mockReturnValue("uat.one.hushh.ai");
    const state = {
      vaultKeyHash: "hash",
      primaryMethod: "generated_default_web_prf" as const,
      primaryWrapperId: "canonical",
      recoveryEncryptedVaultKey: "recovery",
      recoverySalt: "recovery-salt",
      recoveryIv: "recovery-iv",
      wrappers: [
        {
          method: "generated_default_web_prf" as const,
          wrapperId: "canonical",
          encryptedVaultKey: "encrypted",
          salt: "salt",
          iv: "iv",
          passkeyRpId: "one.hushh.ai",
        },
      ],
    };

    expect(
      VaultService.getWrapperByMethod(state, "generated_default_web_prf"),
    ).toMatchObject({
      wrapperId: "canonical",
      passkeyRpId: "one.hushh.ai",
    });
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

    await expect(VaultService.checkVault("user-401-retry")).resolves.toBe(true);

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

  it("never replaces a terminal account-not-found response with stale bootstrap state", async () => {
    publishValidatedAuthSessionOwner("deleted-user");
    mockGetIdToken.mockResolvedValue("deleted-user-token");
    mockBootstrapState.mockResolvedValue({ hasVault: true });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        detail: {
          code: "AUTH_ACCOUNT_NOT_FOUND",
          message: "Account not found",
        },
      }),
    );
    const invalidations: unknown[] = [];
    const listener = (event: Event) => {
      invalidations.push((event as CustomEvent).detail);
    };
    window.addEventListener("auth-session-invalidated", listener);

    try {
      await expect(
        VaultService.checkVault("deleted-user"),
      ).rejects.toMatchObject({
        status: 401,
        code: "AUTH_ACCOUNT_NOT_FOUND",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockGetIdToken).not.toHaveBeenCalledWith(true);
      expect(mockBootstrapState).not.toHaveBeenCalled();
      expect(invalidations).toEqual([
        {
          code: "account_not_found",
          path: "/api/vault/check",
          userId: "deleted-user",
        },
      ]);
    } finally {
      window.removeEventListener("auth-session-invalidated", listener);
    }
  });

  it("does not let a delayed Account A vault failure invalidate Account B", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    publishValidatedAuthSessionOwner("account-a");
    mockGetIdToken.mockResolvedValue("account-a-token");
    fetchMock.mockReturnValueOnce(responsePromise);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    try {
      const request = VaultService.checkVault("account-a");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      publishValidatedAuthSessionOwner("account-b");
      resolveResponse?.(
        jsonResponse(401, {
          detail: { code: "AUTH_ACCOUNT_NOT_FOUND" },
        }),
      );

      await expect(request).rejects.toMatchObject({
        code: "AUTH_ACCOUNT_NOT_FOUND",
      });
      const invalidations = dispatchSpy.mock.calls.filter(
        ([event]) =>
          event instanceof CustomEvent &&
          event.type === "auth-session-invalidated",
      );
      expect(invalidations).toHaveLength(0);
      expect(mockBootstrapState).not.toHaveBeenCalled();
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  it("preserves typed terminal errors from the web getVaultState path", async () => {
    publishValidatedAuthSessionOwner("deleted-state-user");
    mockGetIdToken.mockResolvedValue("deleted-state-token");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        detail: {
          code: "AUTH_ACCOUNT_NOT_FOUND",
          message: "Account not found",
        },
      }),
    );
    const invalidations: unknown[] = [];
    const listener = (event: Event) => {
      invalidations.push((event as CustomEvent).detail);
    };
    window.addEventListener("auth-session-invalidated", listener);

    try {
      await expect(
        VaultService.getVaultState("deleted-state-user"),
      ).rejects.toMatchObject({
        status: 401,
        code: "AUTH_ACCOUNT_NOT_FOUND",
      });
      expect(invalidations).toEqual([
        {
          code: "account_not_found",
          path: "/api/vault/get",
          userId: "deleted-state-user",
        },
      ]);
    } finally {
      window.removeEventListener("auth-session-invalidated", listener);
    }
  });

  it("serves a warm cache normally, but a forced read bypasses it and the proxy cache", async () => {
    publishValidatedAuthSessionOwner("fresh-read-user");
    mockGetIdToken.mockResolvedValue("fresh-token");
    const vaultState = {
      vaultKeyHash: "hash",
      primaryMethod: "passphrase" as const,
      recoveryEncryptedVaultKey: "recovery",
      recoverySalt: "salt",
      recoveryIv: "iv",
      wrappers: [wrapper],
    };
    fetchMock.mockResolvedValue(jsonResponse(200, vaultState));

    await VaultService.getVaultState("fresh-read-user");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Served from the warm client cache: no second network call.
    await VaultService.getVaultState("fresh-read-user");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // An unlock attempt forces a fresh read, bypassing both the client cache
    // and (via `fresh=1`) the `/api/vault/get` proxy's own cache.
    await VaultService.getVaultState("fresh-read-user", { forceFresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const freshUrl = String(fetchMock.mock.calls[1]?.[0] ?? "");
    expect(freshUrl).toContain("fresh=1");
  });

  it.each([
    ["checkVault", mockHasVault, "/db/vault/check"],
    ["getVaultState", mockGetVault, "/db/vault/get"],
  ] as const)(
    "preserves and dispatches typed terminal errors from native %s",
    async (method, nativeCall, path) => {
      nativePlatform.current = true;
      publishValidatedAuthSessionOwner("native-deleted-user");
      mockGetIdToken.mockResolvedValue("native-token");
      nativeCall.mockRejectedValueOnce({
        code: "AUTH_ACCOUNT_NOT_FOUND",
        message: "Account not found",
      });
      const invalidations: unknown[] = [];
      const listener = (event: Event) => {
        invalidations.push((event as CustomEvent).detail);
      };
      window.addEventListener("auth-session-invalidated", listener);

      try {
        await expect(
          method === "checkVault"
            ? VaultService.checkVault("native-deleted-user")
            : VaultService.getVaultState("native-deleted-user"),
        ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_NOT_FOUND" });
        expect(invalidations).toEqual([
          {
            code: "account_not_found",
            path,
            userId: "native-deleted-user",
          },
        ]);
      } finally {
        window.removeEventListener("auth-session-invalidated", listener);
      }
    },
  );
});

describe("VaultService.unlockWithMethod", () => {
  const unlockVaultWithPassphraseMock = vi.mocked(unlockVaultWithPassphrase);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const stateWithoutPassphrase: VaultState = {
    vaultKeyHash: "hash",
    primaryMethod: "generated_default_native_passkey_prf",
    primaryWrapperId: "cred-1",
    recoveryEncryptedVaultKey: "recovery",
    recoverySalt: "salt",
    recoveryIv: "iv",
    wrappers: [
      {
        method: "generated_default_native_passkey_prf",
        wrapperId: "cred-1",
        encryptedVaultKey: "e1",
        salt: "s1",
        iv: "i1",
      },
    ],
  };

  it("throws a distinct, named error when no wrapper exists for the method, instead of a silent null", async () => {
    // Previously this collapsed to the same `null` a failed decrypt returns,
    // so the UI told the owner "that passphrase did not match" even though
    // no passphrase wrapper existed to test it against.
    await expect(
      VaultService.unlockWithMethod({
        state: stateWithoutPassphrase,
        method: "passphrase",
        secretMaterial: "whatever-the-owner-typed",
      }),
    ).rejects.toThrow(/not configured/i);
    expect(unlockVaultWithPassphraseMock).not.toHaveBeenCalled();
  });

  it("still returns null for a genuine decrypt failure against an existing wrapper", async () => {
    unlockVaultWithPassphraseMock.mockResolvedValue("");
    const stateWithPassphrase: VaultState = {
      ...stateWithoutPassphrase,
      wrappers: [
        ...stateWithoutPassphrase.wrappers,
        { method: "passphrase", wrapperId: "default", encryptedVaultKey: "e2", salt: "s2", iv: "i2" },
      ],
    };

    const result = await VaultService.unlockWithMethod({
      state: stateWithPassphrase,
      method: "passphrase",
      secretMaterial: "wrong-passphrase",
    });

    expect(result).toBeNull();
    expect(unlockVaultWithPassphraseMock).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetIdToken, mockBootstrapState, mockHasVault, mockGetVault, mockMutation,
  mockIssueOwner, mockResolveRpId, nativePlatform, sessionStore, cacheStore,
  vaultMutations, syntheticVaultState, deferred } from "./vault-service-check-fixture";

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

  const mutations = vaultMutations(VaultService);

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

  it.each(["one.hushh.ai"])(
    "reuses the stored production RP %s after the spelling migration",
    (storedRp) => {
      mockResolveRpId.mockReturnValue("one.hussh.ai");
      const wrapper = { method: "generated_default_web_prf" as const,
        wrapperId: "legacy", encryptedVaultKey: "encrypted", salt: "salt", iv: "iv",
        passkeyRpId: storedRp, passkeyCredentialId: "credential", passkeyPrfSalt: "prf-salt" };
      const state = { vaultKeyHash: "hash", primaryMethod: wrapper.method,
        primaryWrapperId: wrapper.wrapperId, recoveryEncryptedVaultKey: "recovery",
        recoverySalt: "salt", recoveryIv: "iv", wrappers: [wrapper] };
      expect(VaultService.getWrapperByMethod(state, wrapper.method)).toBe(wrapper);
      for (const host of ["dev.one.hussh.ai", "uat.one.hussh.ai", "evil.one.hussh.ai"]) {
        mockResolveRpId.mockReturnValue(host);
        expect(VaultService.getWrapperByMethod(state, wrapper.method)).toBeNull();
      }
    },
  );

  it("preserves null metadata fallback without choosing it over an incompatible explicit RP", () => {
    mockResolveRpId.mockReturnValue("one.hussh.ai");
    const wrapper = { method: "generated_default_web_prf" as const,
      wrapperId: "missing-rp", encryptedVaultKey: "encrypted", salt: "salt", iv: "iv" };
    const state = { vaultKeyHash: "hash", primaryMethod: wrapper.method,
      primaryWrapperId: wrapper.wrapperId, recoveryEncryptedVaultKey: "recovery",
      recoverySalt: "salt", recoveryIv: "iv", wrappers: [wrapper] };
    expect(VaultService.getWrapperByMethod(state, wrapper.method)).toBe(wrapper);
    const foreign = { ...wrapper, wrapperId: "foreign", passkeyRpId: "uat.one.hushh.ai" };
    expect(VaultService.getWrapperByMethod({ ...state, wrappers: [foreign, wrapper] }, wrapper.method)).toBeNull();
    const compatible = { ...wrapper, wrapperId: "compatible", passkeyRpId: "one.hushh.ai" };
    expect(VaultService.getWrapperByMethod({ ...state, wrappers: [foreign, wrapper, compatible] }, wrapper.method)).toBe(compatible);
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
    const vaultState = syntheticVaultState();
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

  it.each([false, true])("keeps a late ordinary read from replacing fresh metadata (native=%s)", async (native) => {
    nativePlatform.current = native;
    mockGetIdToken.mockResolvedValue("token");
    const provider = native ? mockGetVault : fetchMock;
    const respond = (state: VaultState) => native ? state : jsonResponse(200, state);
    const old = deferred<VaultState>();
    const fresh = deferred<VaultState>();
    provider.mockReset().mockImplementationOnce(() => old.promise.then(respond))
      .mockImplementationOnce(() => fresh.promise.then(respond));
    const ordinary = VaultService.getVaultState("read-race");
    const duplicate = VaultService.getVaultState("read-race");
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    const forced = VaultService.getVaultState("read-race", { forceFresh: true });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
    fresh.resolve(syntheticVaultState("current"));
    expect((await forced).wrappers[0].salt).toBe("current");
    old.resolve(syntheticVaultState("retired"));
    await Promise.all([ordinary, duplicate]);
    expect((await VaultService.getVaultState("read-race")).wrappers[0].salt).toBe("current");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("retires pending fresh reads on owner invalidation (native=%s)", async (native) => {
    nativePlatform.current = native;
    mockGetIdToken.mockResolvedValue("token");
    const provider = native ? mockGetVault : fetchMock;
    const respond = (state: VaultState) => native ? state : jsonResponse(200, state);
    const old = deferred<VaultState>();
    const fresh = deferred<VaultState>();
    provider.mockReset().mockImplementationOnce(() => old.promise.then(respond))
      .mockImplementationOnce(() => fresh.promise.then(respond));
    const initial = VaultService.getVaultState("invalidated-read", { forceFresh: true });
    const duplicate = VaultService.getVaultState("invalidated-read", { forceFresh: true });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    VaultService.invalidateVaultStateCache("invalidated-read");
    const next = VaultService.getVaultState("invalidated-read", { forceFresh: true });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
    old.resolve(syntheticVaultState("retired"));
    await Promise.all([initial, duplicate]);
    expect(sessionStore.has("vault_check:invalidated-read")).toBe(false);
    const ordinary = VaultService.getVaultState("invalidated-read");
    const concurrent = VaultService.getVaultState("invalidated-read", { forceFresh: true });
    fresh.resolve(syntheticVaultState("current"));
    for (const state of await Promise.all([next, ordinary, concurrent])) {
      expect(state.wrappers[0].salt).toBe("current");
    }
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("does not retain stale wrappers after a forced read fails (native=%s)", async (native) => {
    nativePlatform.current = native;
    mockGetIdToken.mockResolvedValue("token");
    const provider = native ? mockGetVault : fetchMock;
    const respond = (state: VaultState) => native ? state : jsonResponse(200, state);
    provider.mockReset().mockResolvedValueOnce(respond(syntheticVaultState("old")))
      .mockRejectedValueOnce(new Error("synthetic offline"))
      .mockResolvedValueOnce(respond(syntheticVaultState("current")));
    await VaultService.getVaultState("failed-fresh-read");
    await expect(VaultService.getVaultState("failed-fresh-read", { forceFresh: true })).rejects.toThrow("synthetic offline");
    expect((await VaultService.getVaultState("failed-fresh-read")).wrappers[0].salt).toBe("current");
    expect(provider).toHaveBeenCalledTimes(3);
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

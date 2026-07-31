import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiJsonMock, getIdTokenMock, primeVerifiedPhoneHintMock } = vi.hoisted(
  () => ({
    apiJsonMock: vi.fn(),
    getIdTokenMock: vi.fn(),
    primeVerifiedPhoneHintMock: vi.fn(),
  }),
);

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
  },
}));

vi.mock("@/lib/services/api-client", () => ({
  apiJson: apiJsonMock,
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getIdToken: getIdTokenMock,
  },
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    primeVerifiedPhoneHint: primeVerifiedPhoneHintMock,
  },
}));

import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("PreVaultUserStateService.bootstrapState", () => {
  beforeEach(() => {
    apiJsonMock.mockReset();
    getIdTokenMock.mockReset();
    primeVerifiedPhoneHintMock.mockReset();
    window.localStorage.clear();
  });

  it("coalesces concurrent cold reads before Firebase token resolution", async () => {
    const token = deferred<string>();
    getIdTokenMock.mockReturnValue(token.promise);
    apiJsonMock.mockResolvedValue({
      userId: "bootstrap-race-user",
      hasVault: false,
      phoneVerified: false,
      setupCompleted: false,
    });

    const first = PreVaultUserStateService.bootstrapState("bootstrap-race-user");
    const second = PreVaultUserStateService.bootstrapState("bootstrap-race-user");

    // `bootstrapState` is async, so callers receive wrapper promises. The
    // shared assertion is that both wrappers join one token/API operation.
    expect(getIdTokenMock).toHaveBeenCalledTimes(1);
    expect(apiJsonMock).not.toHaveBeenCalled();

    token.resolve("firebase-token");
    await expect(first).resolves.toMatchObject({
      userId: "bootstrap-race-user",
      hasVault: false,
      phoneVerified: false,
    });
    await expect(second).resolves.toMatchObject({
      userId: "bootstrap-race-user",
      hasVault: false,
      phoneVerified: false,
    });
    expect(apiJsonMock).toHaveBeenCalledTimes(1);
    expect(primeVerifiedPhoneHintMock).toHaveBeenCalledWith(
      "bootstrap-race-user",
      false,
    );
  });

  it("uses the settled native sign-in token without starting a second token lookup", async () => {
    const userId = "bootstrap-native-apple-user";
    apiJsonMock.mockResolvedValue({
      userId,
      hasVault: false,
      phoneVerified: false,
      setupCompleted: false,
    });

    await PreVaultUserStateService.bootstrapState(userId, {
      idToken: "native-apple-id-token",
    });

    expect(getIdTokenMock).not.toHaveBeenCalled();
    expect(apiJsonMock).toHaveBeenCalledWith(
      "/api/vault/bootstrap-state",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer native-apple-id-token",
        }),
      }),
    );
  });

  it("keeps explicit force refreshes outside the session single-flight", async () => {
    const userId = "bootstrap-force-user";
    getIdTokenMock.mockResolvedValue("firebase-token");
    apiJsonMock
      .mockResolvedValueOnce({
        userId,
        hasVault: false,
        phoneVerified: false,
      })
      .mockResolvedValueOnce({
        userId,
        hasVault: true,
        phoneVerified: true,
        setupCompleted: true,
      });

    await PreVaultUserStateService.bootstrapState(userId);
    await expect(
      PreVaultUserStateService.bootstrapState(userId, { force: true }),
    ).resolves.toMatchObject({ hasVault: true, phoneVerified: true });

    expect(apiJsonMock).toHaveBeenCalledTimes(2);
    expect(OneSetupCompletionHintService.isResolved(userId)).toBe(true);
  });

  it("keeps the sticky completion latch on a stale incomplete or unknown read", async () => {
    const incompleteUserId = "bootstrap-explicit-incomplete-user";
    const unknownUserId = "bootstrap-unknown-setup-user";
    getIdTokenMock.mockResolvedValue("firebase-token");
    OneSetupCompletionHintService.markResolved(incompleteUserId);
    OneSetupCompletionHintService.markResolved(unknownUserId);
    // Any extra (self-heal) write resolves cleanly so the fire-and-forget
    // re-push never rejects during the test.
    apiJsonMock.mockResolvedValue({
      userId: incompleteUserId,
      setupCompleted: true,
    });
    apiJsonMock
      .mockResolvedValueOnce({
        userId: incompleteUserId,
        setupCompleted: false,
      })
      .mockResolvedValueOnce({
        userId: unknownUserId,
        setupCompleted: null,
      });

    await PreVaultUserStateService.bootstrapState(incompleteUserId);
    await PreVaultUserStateService.bootstrapState(unknownUserId);

    // The latch is a sticky, monotonic "onboarding dismissed" signal: a routine
    // or racing `false`/null read must NOT wipe it (that was the guard-bounce
    // bug). It is cleared only by explicit sign-out / account reset.
    expect(OneSetupCompletionHintService.isResolved(incompleteUserId)).toBe(true);
    expect(OneSetupCompletionHintService.isResolved(unknownUserId)).toBe(true);
  });

  it("self-heals the backend when the latch is set but setupCompleted is false", async () => {
    const userId = "bootstrap-self-heal-user";
    getIdTokenMock.mockResolvedValue("firebase-token");
    OneSetupCompletionHintService.markResolved(userId);
    apiJsonMock
      .mockResolvedValueOnce({ userId, setupCompleted: false }) // bootstrap read
      .mockResolvedValueOnce({ userId, setupCompleted: true }); // self-heal re-push

    await PreVaultUserStateService.bootstrapState(userId);

    // The fire-and-forget self-heal re-pushes setupCompleted=true so every
    // device converges even if the dismissal-time write never landed.
    await vi.waitFor(() => {
      expect(apiJsonMock).toHaveBeenCalledTimes(2);
    });
    const healCall = apiJsonMock.mock.calls[1];
    expect(String(healCall?.[0])).toContain("pre-vault-state");
    expect(
      JSON.parse(String((healCall?.[1] as RequestInit).body)),
    ).toMatchObject({ userId, setupCompleted: true });
  });

  it("does not self-heal when the backend read is unknown (null)", async () => {
    const userId = "bootstrap-null-no-heal-user";
    getIdTokenMock.mockResolvedValue("firebase-token");
    OneSetupCompletionHintService.markResolved(userId);
    apiJsonMock.mockResolvedValueOnce({ userId, setupCompleted: null });

    await PreVaultUserStateService.bootstrapState(userId);
    // Let any (unexpected) fire-and-forget heal have a chance to run.
    await Promise.resolve();
    await Promise.resolve();

    // null = legacy/unknown fail-open state; it must NOT trigger a re-push
    // (only an EXPLICIT setupCompleted===false mismatch self-heals). The sticky
    // latch is still preserved.
    expect(apiJsonMock).toHaveBeenCalledTimes(1);
    expect(OneSetupCompletionHintService.isResolved(userId)).toBe(true);
  });

  it("persists the explicit Connections choice without replacing capability markers", async () => {
    const userId = "bootstrap-runtime-choice-user";
    getIdTokenMock.mockResolvedValue("firebase-token");
    apiJsonMock
      .mockResolvedValueOnce({
        userId,
        setupCompleted: false,
        setupCapabilityIds: ["finance"],
      })
      .mockResolvedValueOnce({
        userId,
        setupCompleted: false,
        setupCapabilityIds: ["connections", "finance"],
        oneRuntimeSetupChoice: "byok_pending_vault",
      });

    const state = await PreVaultUserStateService.markOneRuntimeChoice(
      userId,
      "byok_pending_vault",
    );

    expect(PreVaultUserStateService.hasOneRuntimeChoice(state)).toBe(true);
    expect(state.setupCapabilityIds).toEqual(["connections", "finance"]);
    expect(state.oneRuntimeSetupChoice).toBe("byok_pending_vault");
    expect(apiJsonMock).toHaveBeenCalledTimes(2);
    const updateOptions = apiJsonMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(updateOptions.body))).toEqual({
      userId,
      setupCapabilityIds: ["connections", "finance"],
      oneRuntimeSetupChoice: "byok_pending_vault",
    });
  });

  it("updates an existing Connections choice without storing a credential", async () => {
    const userId = "bootstrap-runtime-choice-update-user";
    getIdTokenMock.mockResolvedValue("firebase-token");
    apiJsonMock
      .mockResolvedValueOnce({
        userId,
        setupCompleted: false,
        setupCapabilityIds: ["connections"],
        oneRuntimeSetupChoice: "hushh_managed_vertex",
      })
      .mockResolvedValueOnce({
        userId,
        setupCompleted: false,
        setupCapabilityIds: ["connections"],
        oneRuntimeSetupChoice: "byok_pending_vault",
      });

    await PreVaultUserStateService.markOneRuntimeChoice(
      userId,
      "byok_pending_vault",
    );

    const updateOptions = apiJsonMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(updateOptions.body))).toEqual({
      userId,
      setupCapabilityIds: ["connections"],
      oneRuntimeSetupChoice: "byok_pending_vault",
    });
  });
});

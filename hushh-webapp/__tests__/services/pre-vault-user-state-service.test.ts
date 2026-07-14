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
      });

    await PreVaultUserStateService.bootstrapState(userId);
    await expect(
      PreVaultUserStateService.bootstrapState(userId, { force: true }),
    ).resolves.toMatchObject({ hasVault: true, phoneVerified: true });

    expect(apiJsonMock).toHaveBeenCalledTimes(2);
  });
});

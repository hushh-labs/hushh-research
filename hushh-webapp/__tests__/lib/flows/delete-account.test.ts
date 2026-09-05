import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDeleteAccount,
  mockOnAccountDeleted,
  mockClearForUser,
  mockSetOnboardingRequiredCookie,
  mockSetOnboardingFlowActiveCookie,
  mockPublishAccountDeletionToSiblingTabs,
  mockDispatchAuthSessionInvalidated,
  mockBackendInvalidationCode,
  mockFirebaseInvalidationCode,
  mockGetAccountSessionStatus,
} = vi.hoisted(() => ({
  mockDeleteAccount: vi.fn(),
  mockOnAccountDeleted: vi.fn(),
  mockClearForUser: vi.fn(),
  mockSetOnboardingRequiredCookie: vi.fn(),
  mockSetOnboardingFlowActiveCookie: vi.fn(),
  mockPublishAccountDeletionToSiblingTabs: vi.fn(),
  mockDispatchAuthSessionInvalidated: vi.fn(),
  mockBackendInvalidationCode: vi.fn(),
  mockFirebaseInvalidationCode: vi.fn(),
  mockGetAccountSessionStatus: vi.fn(),
}));

vi.mock("@/lib/auth/session-invalidation", () => ({
  ACCOUNT_DELETION_OUTCOME_UNCERTAIN_MESSAGE:
    "We couldn't confirm whether account deletion finished. For your security, we signed you out and won't retry it automatically. Please check your connection before signing in again.",
  AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE: "AUTH_ACCOUNT_NOT_FOUND",
  publishAccountDeletionToSiblingTabs: mockPublishAccountDeletionToSiblingTabs,
  dispatchAuthSessionInvalidated: mockDispatchAuthSessionInvalidated,
  authSessionInvalidationCodeFromBackendPayload: mockBackendInvalidationCode,
  authSessionInvalidationCodeFromFirebaseError: mockFirebaseInvalidationCode,
}));

vi.mock("@/lib/services/account-service", () => ({
  AccountService: { deleteAccount: mockDeleteAccount },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getAccountSessionStatus: mockGetAccountSessionStatus },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onAccountDeleted: mockOnAccountDeleted },
}));

vi.mock("@/lib/services/user-local-state-service", () => ({
  UserLocalStateService: { clearForUser: mockClearForUser },
}));

vi.mock("@/lib/services/onboarding-route-cookie", () => ({
  setOnboardingRequiredCookie: mockSetOnboardingRequiredCookie,
  setOnboardingFlowActiveCookie: mockSetOnboardingFlowActiveCookie,
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {},
}));

import {
  ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE,
  ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_MESSAGE,
  AccountDeletionOutcomeUncertainError,
  DELETE_ACCOUNT_OUTCOME_UNCERTAIN_MESSAGE,
  accountDeletionErrorMessage,
  executeVerifiedAccountDeletion,
} from "@/lib/flows/delete-account";
import { ApiError } from "@/lib/services/api-client";

function makeSessionUser(uid = "user_123") {
  return {
    uid,
    getIdToken: vi.fn().mockResolvedValue("firebase-token"),
  };
}

describe("executeVerifiedAccountDeletion", () => {
  afterEach(() => vi.useRealTimers());

  it("never submits deletion after a token-read timeout, even if the bridge later returns", async () => {
    vi.useFakeTimers();
    const sessionUser = makeSessionUser();
    let release!: (token: string) => void;
    sessionUser.getIdToken.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const action = executeVerifiedAccountDeletion({
      userId: "user_123",
      vaultOwnerToken: "vault-token",
      sessionUser,
    });
    const rejection = expect(action).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
    release("late-token");
    await Promise.resolve();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockDispatchAuthSessionInvalidated).not.toHaveBeenCalled();
  });

  it("bounds uncertain-outcome verification when a backend read never settles", async () => {
    vi.useFakeTimers();
    mockDeleteAccount.mockRejectedValue(new Error("lost response"));
    mockGetAccountSessionStatus.mockImplementation(() => new Promise(() => {}));
    const action = executeVerifiedAccountDeletion({
      userId: "user_123",
      vaultOwnerToken: "vault-token",
      sessionUser: makeSessionUser(),
    });
    const rejection = expect(action).rejects.toBeInstanceOf(
      AccountDeletionOutcomeUncertainError,
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
    expect(mockDispatchAuthSessionInvalidated).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "account_deletion_uncertain",
        userId: "user_123",
      }),
    );
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockClearForUser.mockResolvedValue(undefined);
    mockBackendInvalidationCode.mockReturnValue(null);
    mockFirebaseInvalidationCode.mockReturnValue(null);
  });

  it("clears owner state only after a confirmed full account deletion", async () => {
    mockDeleteAccount.mockResolvedValue({
      success: true,
      account_deleted: true,
      details: { firebase_auth_user: "deleted" },
    });

    await executeVerifiedAccountDeletion({
      userId: "user_123",
      vaultOwnerToken: "vault-token",
      sessionUser: makeSessionUser(),
    });

    expect(mockOnAccountDeleted).toHaveBeenCalledWith("user_123");
    expect(mockPublishAccountDeletionToSiblingTabs).toHaveBeenCalledWith(
      "user_123",
    );
    expect(
      mockPublishAccountDeletionToSiblingTabs.mock.invocationCallOrder[0],
    ).toBeLessThan(mockOnAccountDeleted.mock.invocationCallOrder[0]!);
    expect(mockClearForUser).toHaveBeenCalledWith("user_123");
    expect(mockSetOnboardingRequiredCookie).toHaveBeenCalledWith(false);
    expect(mockSetOnboardingFlowActiveCookie).toHaveBeenCalledWith(false);
    expect(mockDispatchAuthSessionInvalidated).toHaveBeenCalledWith({
      code: "account_deleted",
      path: "account_delete_confirmed",
      userId: "user_123",
    });
    expect(
      mockDispatchAuthSessionInvalidated.mock.invocationCallOrder[0],
    ).toBeLessThan(mockClearForUser.mock.invocationCallOrder[0]!);
  });

  it("accepts a data-deleted account whose Firebase identity was quarantined", async () => {
    mockDeleteAccount.mockResolvedValue({
      success: true,
      account_deleted: true,
      details: {
        firebase_auth_user: "quarantined",
        firebase_auth_user_deletion_incomplete: true,
        firebase_auth_user_quarantined: true,
      },
    });

    await expect(
      executeVerifiedAccountDeletion({
        userId: "user_123",
        vaultOwnerToken: "vault-token",
        sessionUser: makeSessionUser(),
      }),
    ).resolves.toBeUndefined();

    expect(mockOnAccountDeleted).toHaveBeenCalledWith("user_123");
    expect(mockClearForUser).toHaveBeenCalledWith("user_123");
    expect(mockDispatchAuthSessionInvalidated).toHaveBeenCalledWith({
      code: "account_deleted",
      path: "account_delete_confirmed",
      userId: "user_123",
    });
  });

  it.each([
    { success: false, account_deleted: false },
    { success: true, account_deleted: false },
    { success: true },
    {},
  ])(
    "fails closed after a non-canonical success payload without clearing local state",
    async (result) => {
      const sessionUser = makeSessionUser();
      mockDeleteAccount.mockResolvedValue(result);
      mockGetAccountSessionStatus.mockResolvedValue(
        Response.json({ detail: "Service unavailable" }, { status: 503 }),
      );

      await expect(
        executeVerifiedAccountDeletion({
          userId: "user_123",
          vaultOwnerToken: "vault-token",
          sessionUser,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          name: "AccountDeletionOutcomeUncertainError",
          message: DELETE_ACCOUNT_OUTCOME_UNCERTAIN_MESSAGE,
        }),
      );

      expect(mockOnAccountDeleted).not.toHaveBeenCalled();
      expect(mockPublishAccountDeletionToSiblingTabs).not.toHaveBeenCalled();
      expect(mockClearForUser).not.toHaveBeenCalled();
      expect(mockSetOnboardingRequiredCookie).not.toHaveBeenCalled();
      expect(mockSetOnboardingFlowActiveCookie).not.toHaveBeenCalled();
      expect(sessionUser.getIdToken).toHaveBeenCalledWith(false);
      expect(sessionUser.getIdToken).toHaveBeenCalledWith(true);
      expect(mockDispatchAuthSessionInvalidated).toHaveBeenCalledWith({
        code: "account_deletion_uncertain",
        path: "account_delete_uncertain_unverified",
        userId: "user_123",
      });
    },
  );

  it.each([{ success: true }, {}])(
    "accepts a malformed fulfilled response only after the tombstone is confirmed",
    async (result) => {
      mockDeleteAccount.mockResolvedValue(result);
      mockGetAccountSessionStatus.mockResolvedValue(
        Response.json(
          { detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } },
          { status: 401 },
        ),
      );
      mockBackendInvalidationCode.mockReturnValue("account_not_found");

      await expect(
        executeVerifiedAccountDeletion({
          userId: "user_123",
          vaultOwnerToken: "vault-token",
          sessionUser: makeSessionUser(),
        }),
      ).resolves.toBeUndefined();

      expect(mockDispatchAuthSessionInvalidated).toHaveBeenCalledWith({
        code: "account_not_found",
        path: "account_delete_uncertain_outcome",
        userId: "user_123",
      });
      expect(mockClearForUser).toHaveBeenCalledWith("user_123");
    },
  );

  it("treats a lost delete response as success only after the tombstone is confirmed", async () => {
    const transportError = new TypeError("Failed to fetch");
    const sessionUser = makeSessionUser();
    mockDeleteAccount.mockRejectedValue(transportError);
    mockGetAccountSessionStatus.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }),
        { status: 401 },
      ),
    );
    mockBackendInvalidationCode.mockReturnValue("account_not_found");

    await expect(
      executeVerifiedAccountDeletion({
        userId: "user_123",
        vaultOwnerToken: "vault-token",
        sessionUser,
      }),
    ).resolves.toBeUndefined();

    expect(sessionUser.getIdToken).toHaveBeenCalledWith(false);
    expect(sessionUser.getIdToken).not.toHaveBeenCalledWith(true);
    expect(mockDispatchAuthSessionInvalidated).toHaveBeenCalledWith({
      code: "account_not_found",
      path: "account_delete_uncertain_outcome",
      userId: "user_123",
    });
    expect(mockDispatchAuthSessionInvalidated).toHaveBeenCalledTimes(1);
    expect(mockPublishAccountDeletionToSiblingTabs).toHaveBeenCalledWith(
      "user_123",
    );
    expect(mockClearForUser).toHaveBeenCalledWith("user_123");
  });

  it("fails closed when a lost-response probe sees a pre-commit active snapshot", async () => {
    const transportError = new TypeError("Failed to fetch");
    const sessionUser = makeSessionUser();
    mockDeleteAccount.mockRejectedValue(transportError);
    mockGetAccountSessionStatus.mockResolvedValue(
      Response.json({ active: true }, { status: 200 }),
    );

    await expect(
      executeVerifiedAccountDeletion({
        userId: "user_123",
        vaultOwnerToken: "vault-token",
        sessionUser,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "AccountDeletionOutcomeUncertainError",
        originalError: transportError,
      }),
    );

    expect(sessionUser.getIdToken).toHaveBeenCalledWith(false);
    expect(sessionUser.getIdToken).not.toHaveBeenCalledWith(true);
    expect(mockDispatchAuthSessionInvalidated).toHaveBeenCalledWith({
      code: "account_deletion_uncertain",
      path: "account_delete_uncertain_unverified",
      userId: "user_123",
    });
    expect(mockClearForUser).not.toHaveBeenCalled();
  });

  it("does not claim deletion when both status probes are unavailable", async () => {
    const transportError = new TypeError("Failed to fetch");
    const sessionUser = makeSessionUser();
    mockDeleteAccount.mockRejectedValue(transportError);
    mockGetAccountSessionStatus.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Service unavailable" }), {
        status: 503,
      }),
    );

    await expect(
      executeVerifiedAccountDeletion({
        userId: "user_123",
        vaultOwnerToken: "vault-token",
        sessionUser,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "AccountDeletionOutcomeUncertainError",
        message: DELETE_ACCOUNT_OUTCOME_UNCERTAIN_MESSAGE,
        originalError: transportError,
      }),
    );

    expect(sessionUser.getIdToken).toHaveBeenNthCalledWith(1, false);
    expect(sessionUser.getIdToken).toHaveBeenNthCalledWith(2, true);
    expect(mockGetAccountSessionStatus).toHaveBeenCalledTimes(2);
    expect(mockDispatchAuthSessionInvalidated).toHaveBeenCalledWith({
      code: "account_deletion_uncertain",
      path: "account_delete_uncertain_unverified",
      userId: "user_123",
    });
    expect(mockClearForUser).not.toHaveBeenCalled();
  });

  it("uses explicit no-auto-retry copy only for an uncertain destructive outcome", () => {
    expect(
      accountDeletionErrorMessage(
        new AccountDeletionOutcomeUncertainError(new TypeError("offline")),
      ),
    ).toBe(DELETE_ACCOUNT_OUTCOME_UNCERTAIN_MESSAGE);
    expect(accountDeletionErrorMessage(new TypeError("offline"))).toBe(
      "Failed to delete account. Please try again.",
    );
  });

  it("keeps the session recoverable for the exact pre-submit external-resource conflict", async () => {
    const preconditionError = new ApiError(
      "External resources must be removed first.",
      409,
      {
        detail: {
          code: ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE,
        },
      },
    );
    mockDeleteAccount.mockRejectedValue(preconditionError);
    const sessionUser = makeSessionUser();

    await expect(
      executeVerifiedAccountDeletion({
        userId: "user_123",
        vaultOwnerToken: "vault-token",
        sessionUser,
      }),
    ).rejects.toBe(preconditionError);

    expect(accountDeletionErrorMessage(preconditionError)).toBe(
      ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_MESSAGE,
    );
    expect(mockGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(mockDispatchAuthSessionInvalidated).not.toHaveBeenCalled();
    expect(mockOnAccountDeleted).not.toHaveBeenCalled();
    expect(mockClearForUser).not.toHaveBeenCalled();
    expect(sessionUser.getIdToken).toHaveBeenCalledTimes(1);
    expect(sessionUser.getIdToken).toHaveBeenCalledWith(false);
  });

  it("accepts the tombstone code returned by an idempotent repeat delete", async () => {
    const sessionUser = makeSessionUser();
    mockDeleteAccount.mockRejectedValue(
      new ApiError("Account not found", 401, {
        detail: { code: "AUTH_ACCOUNT_NOT_FOUND" },
      }),
    );

    await expect(
      executeVerifiedAccountDeletion({
        userId: "user_123",
        vaultOwnerToken: "erased-vault-token",
        sessionUser,
      }),
    ).resolves.toBeUndefined();

    expect(mockGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(mockDispatchAuthSessionInvalidated).toHaveBeenCalledWith({
      code: "account_not_found",
      path: "account_delete_uncertain_outcome",
      userId: "user_123",
    });
    expect(mockClearForUser).toHaveBeenCalledWith("user_123");
  });

  it("refuses to delete when the supplied Firebase identity changed", async () => {
    await expect(
      executeVerifiedAccountDeletion({
        userId: "user_123",
        vaultOwnerToken: "vault-token",
        sessionUser: makeSessionUser("different-user"),
      }),
    ).rejects.toThrow("Account deletion session identity changed");

    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(mockClearForUser).not.toHaveBeenCalled();
  });
});

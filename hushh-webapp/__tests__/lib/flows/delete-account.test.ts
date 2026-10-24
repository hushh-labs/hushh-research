import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  makeSessionUser,
  mockDeleteAccount,
  mockOnAccountDeleted,
  mockClearForUser,
  mockClearDeviceSecrets,
  mockSetOnboardingRequiredCookie,
  mockSetOnboardingFlowActiveCookie,
  mockPublishAccountDeletionToSiblingTabs,
  mockDispatchAuthSessionInvalidated,
  mockBackendInvalidationCode,
  mockFirebaseInvalidationCode,
  mockGetAccountSessionStatus,
  mockRevokeAllVaultPlaid,
  mockSnapshotOwner,
  mockOwnerIsCurrent,
  mockRequireVerification,
} from "./delete-account.fixture";

import {
  ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE,
  ACCOUNT_DELETION_FAILED_CODE,
  ACCOUNT_DELETION_NOT_COMPLETED_MESSAGE,
  ACCOUNT_DELETION_PAUSED_CODE,
  ACCOUNT_DELETION_PAUSED_MESSAGE,
  AccountDeletionNotCompletedError,
  ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_MESSAGE,
  AccountDeletionOutcomeUncertainError,
  AccountDeletionInProgressError,
  AccountErasureBanksNotDisconnectedError,
  DELETE_ACCOUNT_OUTCOME_UNCERTAIN_MESSAGE,
  accountDeletionErrorMessage,
  executeVerifiedAccountDeletion,
  isHandledAccountDeletionOutcome,
} from "@/lib/flows/delete-account";
import { ApiError } from "@/lib/services/api-client";
import { isAccountDeletionActive } from "@/lib/auth/account-deletion-activity";
import { ACCOUNT_SESSION_VALIDATION_BUDGET_MS } from "@/lib/auth/account-session-policy";


describe("@feature_account_deletion @trace_loop executeVerifiedAccountDeletion", () => {
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
    await vi.advanceTimersByTimeAsync(ACCOUNT_SESSION_VALIDATION_BUDGET_MS);
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
    mockClearDeviceSecrets.mockResolvedValue(undefined);
    mockBackendInvalidationCode.mockReturnValue(null);
    mockFirebaseInvalidationCode.mockReturnValue(null);
    mockSnapshotOwner.mockReturnValue(null);
    mockOwnerIsCurrent.mockReturnValue(true);
  });

  it("retains a reported rollback when authoritative status arrives after nine seconds", async () => {
    vi.useFakeTimers();
    mockDeleteAccount.mockRejectedValue(new ApiError("failed", 500, {
      code: "ACCOUNT_DELETION_FAILED",
    }));
    mockGetAccountSessionStatus.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(Response.json({ active: true })), 9_000);
    }));
    const action = executeVerifiedAccountDeletion({ userId: "user_123", vaultOwnerToken: "vault-token", sessionUser: makeSessionUser() });
    const rejection = expect(action).rejects.toBeInstanceOf(AccountDeletionNotCompletedError);
    await vi.advanceTimersByTimeAsync(9_000);
    await rejection;
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    expect(mockDispatchAuthSessionInvalidated).not.toHaveBeenCalled();
  });

  it("accepts a committed tombstone after nine seconds without an uncertain sign-out", async () => {
    vi.useFakeTimers();
    mockDeleteAccount.mockRejectedValue(new Error("lost response"));
    mockBackendInvalidationCode.mockReturnValue("account_not_found");
    mockGetAccountSessionStatus.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 })), 9_000);
    }));
    const action = executeVerifiedAccountDeletion({ userId: "user_123", vaultOwnerToken: "vault-token", sessionUser: makeSessionUser() });
    await vi.advanceTimersByTimeAsync(9_000);
    await action;
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    expect(mockDispatchAuthSessionInvalidated).not.toHaveBeenCalledWith(expect.objectContaining({ code: "account_deletion_uncertain" }));
  });

  it("hands a still-running deletion to the sealed owner gate without a second DELETE", async () => {
    const owner = { userId: "user_123", generation: 7 };
    mockSnapshotOwner.mockReturnValue(owner);
    mockDeleteAccount.mockRejectedValue(new Error("lost response"));
    mockGetAccountSessionStatus.mockResolvedValue(Response.json({ detail: { code: "AUTH_ACCOUNT_DELETION_IN_PROGRESS" } }, { status: 423, headers: { "Retry-After": "2" } }));
    const sessionUser = makeSessionUser();
    await expect(executeVerifiedAccountDeletion({ userId: "user_123", vaultOwnerToken: "vault-token", sessionUser })).rejects.toBeInstanceOf(AccountDeletionInProgressError);
    expect(mockRequireVerification).toHaveBeenCalledWith(owner, "account_deletion_in_progress");
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    expect(sessionUser.getIdToken).not.toHaveBeenCalledWith(true);
    expect(mockDispatchAuthSessionInvalidated).not.toHaveBeenCalled();
    expect(mockClearForUser).not.toHaveBeenCalled();
  });

  it("refuses submission after the captured owner generation changes", async () => {
    mockSnapshotOwner.mockReturnValue({ userId: "user_123", generation: 7 });
    mockOwnerIsCurrent.mockReturnValue(false);
    await expect(executeVerifiedAccountDeletion({ userId: "user_123", vaultOwnerToken: "vault-token", sessionUser: makeSessionUser() })).rejects.toThrow("cancelled before submission");
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockRequireVerification).not.toHaveBeenCalled();
    expect(mockClearForUser).not.toHaveBeenCalled();
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
    expect(mockClearForUser).toHaveBeenCalledWith("user_123", { deleteDurableReceipts: true });
    expect(mockClearDeviceSecrets).toHaveBeenCalledWith("user_123");
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

  it("does not let a stalled device-secret cleanup hold a committed deletion open", async () => {
    vi.useFakeTimers();
    mockDeleteAccount.mockResolvedValue({ success: true, account_deleted: true });
    mockClearDeviceSecrets.mockImplementation(() => new Promise(() => {}));

    const action = executeVerifiedAccountDeletion({
      userId: "user_123",
      vaultOwnerToken: "vault-token",
      sessionUser: makeSessionUser(),
    });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(action).resolves.toBeUndefined();
    expect(mockSetOnboardingRequiredCookie).toHaveBeenCalledWith(false);
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
    expect(mockClearForUser).toHaveBeenCalledWith("user_123", { deleteDurableReceipts: true });
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
      expect(mockClearForUser).toHaveBeenCalledWith("user_123", { deleteDurableReceipts: true });
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
    expect(mockClearForUser).toHaveBeenCalledWith("user_123", { deleteDurableReceipts: true });
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

  function reportedDeletionFailure() {
    return new ApiError("Account deletion failed", 500, {
      detail: "Account deletion failed",
      code: ACCOUNT_DELETION_FAILED_CODE,
    });
  }

  it.each([
    { status: 500, code: ACCOUNT_DELETION_FAILED_CODE, active: true, pending: true,
      message: ACCOUNT_DELETION_NOT_COMPLETED_MESSAGE, paused: false },
    { status: 503, code: ACCOUNT_DELETION_PAUSED_CODE, active: true, pending: true,
      message: ACCOUNT_DELETION_PAUSED_MESSAGE, paused: true },
    { status: 409, code: "FILES_ERASURE_IN_PROGRESS", active: true, pending: true,
      message: "Files cleanup is still in progress. Account not deleted. Try again to continue.", paused: false },
    { status: 409, code: "FILES_ERASURE_WAITING_FOR_WRITES", active: true, pending: true,
      message: "An upload outcome is unverified. Account not deleted. Contact support before retrying.", paused: false },
    { status: 500, code: "FILES_ERASURE_WAITING_FOR_WRITES", active: true, pending: false },
    { status: 409, code: "FILES_ERASURE_WAITING_FOR_WRITES", active: false, pending: false },
    { status: 500, code: "FILES_ERASURE_IN_PROGRESS", active: true, pending: false },
    { status: 409, code: "FILES_ERASURE_IN_PROGRESS", active: false, pending: false },
    { status: 409, code: "FILES_ERASURE_LIST_UNCONFIRMED", active: true, pending: false },
  ])("keeps the session only with an exact refusal and active owner: $status/$code/$active", async ({ status, code, active, pending, ...outcome }) => {
    const failure = new ApiError("untrusted detail", status, { code });
    mockDeleteAccount.mockRejectedValue(failure);
    mockGetAccountSessionStatus.mockImplementation(async () => active
      ? Response.json({ active: true })
      : new Response("unavailable", { status: 503 }));
    const error = await executeVerifiedAccountDeletion({
      userId: "user_123", vaultOwnerToken: "vault-token", sessionUser: makeSessionUser(),
    }).catch((caught: unknown) => caught);

    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    expect(mockClearForUser).not.toHaveBeenCalled();
    expect(mockClearDeviceSecrets).not.toHaveBeenCalled();
    expect(mockPublishAccountDeletionToSiblingTabs).not.toHaveBeenCalled();
    if (pending) {
      expect(error).toBeInstanceOf(AccountDeletionNotCompletedError);
      expect(error).toMatchObject({ originalError: failure, paused: outcome.paused });
      expect(accountDeletionErrorMessage(error)).toBe(outcome.message);
      expect(mockOnAccountDeleted).not.toHaveBeenCalled();
      expect(mockDispatchAuthSessionInvalidated).not.toHaveBeenCalled();
      expect(isAccountDeletionActive("user_123")).toBe(false);
    } else {
      expect(error).toBeInstanceOf(AccountDeletionOutcomeUncertainError);
      expect(mockDispatchAuthSessionInvalidated).toHaveBeenCalledWith(
        expect.objectContaining({ code: "account_deletion_uncertain", userId: "user_123" }),
      );
    }
  });

  it("treats a reported failure as deleted when the tombstone shows an ambiguous commit landed", async () => {
    mockDeleteAccount.mockRejectedValue(reportedDeletionFailure());
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
    expect(mockClearForUser).toHaveBeenCalledWith("user_123", { deleteDurableReceipts: true });
    expect(mockClearDeviceSecrets).toHaveBeenCalledWith("user_123");
  });

  it("still fails closed on a reported failure when the account status cannot be read", async () => {
    mockDeleteAccount.mockRejectedValue(reportedDeletionFailure());
    mockGetAccountSessionStatus.mockResolvedValue(
      new Response("unavailable", { status: 503 }),
    );

    await expect(
      executeVerifiedAccountDeletion({
        userId: "user_123",
        vaultOwnerToken: "vault-token",
        sessionUser: makeSessionUser(),
      }),
    ).rejects.toBeInstanceOf(AccountDeletionOutcomeUncertainError);

    expect(mockDispatchAuthSessionInvalidated).toHaveBeenCalledWith(
      expect.objectContaining({ code: "account_deletion_uncertain" }),
    );
    expect(mockClearForUser).not.toHaveBeenCalled();
    expect(mockClearDeviceSecrets).not.toHaveBeenCalled();
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
    expect(mockClearDeviceSecrets).not.toHaveBeenCalled();
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
    expect(mockClearForUser).toHaveBeenCalledWith("user_123", { deleteDurableReceipts: true });
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

describe("@feature_account_deletion @trace_loop banks sealed in the vault are revoked before the account is erased", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSnapshotOwner.mockReturnValue(null);
    mockOwnerIsCurrent.mockReturnValue(true);
    mockDeleteAccount.mockResolvedValue({ success: true, account_deleted: true });
  });

  it("does not reuse deletion approval after sign-out and same-owner return during bank preflight", async () => {
    let generation = 7;
    mockSnapshotOwner.mockImplementation(() => ({ userId: "user_123", generation }));
    mockOwnerIsCurrent.mockImplementation((owner) => owner.generation === generation);
    let finishPreflight!: (outcome: { revoked: number; failed: number }) => void;
    mockRevokeAllVaultPlaid.mockImplementation(() => new Promise((resolve) => {
      finishPreflight = resolve;
    }));
    const action = executeVerifiedAccountDeletion({
      userId: "user_123",
      vaultOwnerToken: "vault-owner-token",
      sessionUser: makeSessionUser(),
      vaultKey: "vault-key",
    });
    const rejected = expect(action).rejects.toThrow("cancelled before submission");
    await vi.waitFor(() => expect(mockRevokeAllVaultPlaid).toHaveBeenCalledOnce());
    generation = 9;
    finishPreflight({ revoked: 0, failed: 0 });
    await rejected;
    expect(mockSnapshotOwner).toHaveBeenCalledOnce();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockRequireVerification).not.toHaveBeenCalled();
    expect(mockClearForUser).not.toHaveBeenCalled();
  });

  it("revokes every connection at Plaid before the delete request", async () => {
    mockRevokeAllVaultPlaid.mockResolvedValue({ revoked: 2, failed: 0 });
    await executeVerifiedAccountDeletion({
      userId: "user_123",
      vaultOwnerToken: "vault-owner-token",
      sessionUser: makeSessionUser(),
      vaultKey: "vault-key",
    }).catch(() => undefined);

    expect(mockRevokeAllVaultPlaid).toHaveBeenCalledWith({
      userId: "user_123",
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-owner-token",
    });
    expect(mockRevokeAllVaultPlaid.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDeleteAccount.mock.invocationCallOrder[0]!,
    );
  });

  it("deletes nothing when a connection could not be revoked", async () => {
    mockRevokeAllVaultPlaid.mockResolvedValue({ revoked: 1, failed: 1 });
    const action = executeVerifiedAccountDeletion({
      userId: "user_123",
      vaultOwnerToken: "vault-owner-token",
      sessionUser: makeSessionUser(),
      vaultKey: "vault-key",
    });

    await expect(action).rejects.toBeInstanceOf(AccountErasureBanksNotDisconnectedError);
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(accountDeletionErrorMessage(await action.catch((e: unknown) => e))).toMatch(/nothing was deleted/);
  });

  it("deletes nothing when the vault cannot be read", async () => {
    mockRevokeAllVaultPlaid.mockRejectedValue(new Error("network"));
    await expect(
      executeVerifiedAccountDeletion({
        userId: "user_123",
        vaultOwnerToken: "vault-owner-token",
        sessionUser: makeSessionUser(),
        vaultKey: "vault-key",
      }),
    ).rejects.toBeInstanceOf(AccountErasureBanksNotDisconnectedError);
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it("skips the step when the vault is not open on this device", async () => {
    await executeVerifiedAccountDeletion({
      userId: "user_123",
      vaultOwnerToken: "vault-owner-token",
      sessionUser: makeSessionUser(),
    }).catch(() => undefined);

    expect(mockRevokeAllVaultPlaid).not.toHaveBeenCalled();
    expect(mockDeleteAccount).toHaveBeenCalled();
  });

  it("treats explained deletion outcomes as handled, and anything else as a crash", () => {
    expect(
      isHandledAccountDeletionOutcome(
        new AccountDeletionOutcomeUncertainError(new TypeError("offline")),
      ),
    ).toBe(true);
    expect(
      isHandledAccountDeletionOutcome(new AccountDeletionNotCompletedError(null)),
    ).toBe(true);
    expect(
      isHandledAccountDeletionOutcome(
        new ApiError("blocked", 409, {
          detail: {
            code: ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE,
          },
        }),
      ),
    ).toBe(true);
    expect(isHandledAccountDeletionOutcome(new AccountErasureBanksNotDisconnectedError(1))).toBe(
      true,
    );
    expect(isHandledAccountDeletionOutcome(new Error("unexpected"))).toBe(false);
  });

  it("marks background work as deletion-interrupted only while deletion may have happened", async () => {
    mockGetAccountSessionStatus.mockResolvedValue(
      Response.json({ active: true }, { status: 200 }),
    );
    mockDeleteAccount.mockRejectedValueOnce(
      new ApiError("Account deletion failed", 500, {
        detail: "Account deletion failed",
        code: ACCOUNT_DELETION_FAILED_CODE,
      }),
    );
    await expect(
      executeVerifiedAccountDeletion({
        userId: "uid-rolled-back",
        vaultOwnerToken: "vault-token",
        sessionUser: makeSessionUser("uid-rolled-back"),
      }),
    ).rejects.toBeInstanceOf(AccountDeletionNotCompletedError);
    expect(isAccountDeletionActive("uid-rolled-back")).toBe(false);

    mockDeleteAccount.mockRejectedValueOnce(
      new ApiError("blocked", 409, {
        detail: { code: ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE },
      }),
    );
    await expect(
      executeVerifiedAccountDeletion({
        userId: "uid-blocked",
        vaultOwnerToken: "vault-token",
        sessionUser: makeSessionUser("uid-blocked"),
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(isAccountDeletionActive("uid-blocked")).toBe(false);

    mockDeleteAccount.mockResolvedValueOnce({ success: true, account_deleted: true });
    await executeVerifiedAccountDeletion({
      userId: "uid-deleted",
      vaultOwnerToken: "vault-token",
      sessionUser: makeSessionUser("uid-deleted"),
    });
    expect(isAccountDeletionActive("uid-deleted")).toBe(true);
  });


});

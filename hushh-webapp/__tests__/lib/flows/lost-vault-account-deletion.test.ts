import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ deletion: vi.fn(), dispatch: vi.fn(), clear: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/services/account-service", () => ({ AccountService: { deleteLostVaultAccount: mocks.deletion } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: { onAccountDeleted: vi.fn() } }));
vi.mock("@/lib/services/user-local-state-service", () => ({ UserLocalStateService: { clearForUser: mocks.clear, clearDeviceSecretsForDeletedAccount: vi.fn() } }));
vi.mock("@/lib/services/onboarding-route-cookie", () => ({ setOnboardingRequiredCookie: vi.fn(), setOnboardingFlowActiveCookie: vi.fn() }));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: {} }));
vi.mock("@/lib/auth/session-invalidation", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/auth/session-invalidation")>()), dispatchAuthSessionInvalidated: mocks.dispatch, publishAccountDeletionToSiblingTabs: mocks.publish }));
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { ApiError } from "@/lib/services/api-client";
import { executeLostVaultAccountDeletion } from "@/lib/flows/delete-account";
import { isAccountDeletionActive } from "@/lib/auth/account-deletion-activity";
const makeSessionUser = () => ({ uid: "user_123", getIdToken: vi.fn(async () => "synthetic-token") });
describe("lost-vault deletion submission and terminal outcomes", () => {
  beforeEach(() => { vi.clearAllMocks(); publishValidatedAuthSessionPrincipal(null); publishValidatedAuthSessionPrincipal({ firebaseUid: "user_123", ownerId: "user_123", accountGeneration: 0 }); mocks.clear.mockResolvedValue(undefined); });
  it.each([
    [true, "account_deleted_ready_to_start_fresh", "27b517dc-d694-44e3-a9be-ed8ae0484de2"],
    [false, "account_deletion_finishing", undefined],
  ])("reports locked-vault deletion readiness %s at sign-out", async (ready, code, continuationId) => {
    mocks.deletion.mockResolvedValue({
      success: true,
      account_deleted: true,
      ready_to_start_fresh: ready,
    });

    await executeLostVaultAccountDeletion({
      userId: "user_123",
      sessionUser: makeSessionUser(),
      firebaseIdToken: "fresh-provider-token",
      ...(continuationId ? {continuationId} : {}),
    });

    expect(mocks.deletion).toHaveBeenCalledWith({
      firebaseIdToken: "fresh-provider-token",
      ...(continuationId ? {continuationId} : {}),
      phoneIdToken: undefined,
      isCurrent: expect.any(Function),
    });
    expect(mocks.dispatch).toHaveBeenCalledWith({ generation: expect.any(Number),
      code,
      path: "account_delete_confirmed",
      userId: "user_123",
    });
  });
  it("aborts lost-vault deletion when its initiating session changes during token capture", async () => {
    let resolve!: (value: string) => void;
    const token = new Promise<string>(done => { resolve = done; });
    let current = true;
    publishValidatedAuthSessionPrincipal({ firebaseUid: "cancelled-owner", ownerId: "cancelled-owner", accountGeneration: 0 });
    const sessionUser = { uid: "cancelled-owner", getIdToken: vi.fn(() => token) };
    const deletion = executeLostVaultAccountDeletion({ userId: sessionUser.uid, sessionUser, firebaseIdToken: "fresh-provider", isCurrent: () => current });
    current = false; resolve("old-owner-token");
    await expect(deletion).rejects.toThrow("cancelled before submission");
    expect(mocks.deletion).not.toHaveBeenCalled();
    expect(isAccountDeletionActive(sessionUser.uid)).toBe(false);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("carries deliberately retained identity through central sign-out instead of reporting pending removal", async () => {
    mocks.deletion.mockResolvedValue({ success: true, account_deleted: true, ready_to_start_fresh: false, details: { firebase_auth_user: "identity_retained" } });
    await executeLostVaultAccountDeletion({ userId: "user_123", sessionUser: makeSessionUser(), firebaseIdToken: "fresh-provider" });
    expect(mocks.dispatch).toHaveBeenCalledWith({ generation: expect.any(Number), code: "account_deletion_identity_retained", path: "account_delete_confirmed", userId: "user_123" });
    expect(mocks.clear).toHaveBeenCalledWith("user_123", { deleteDurableReceipts: true });
    expect(mocks.publish).toHaveBeenCalledWith("user_123");
  });

  it("hands off accepted cleanup without a terminal deletion signal or durable purge", async () => {
    mocks.deletion.mockResolvedValue({
      success: true, account_deleted: false, cleanup_pending: true,
      cleanup_operation: {
        id: "11111111-1111-1111-1111-111111111111", owner_id: "user_123",
        local_erasure_confirmation_required: false,
      },
    });
    const result = await executeLostVaultAccountDeletion({
      userId: "user_123", sessionUser: makeSessionUser(), firebaseIdToken: "fresh-provider",
      reviewedInventorySha256: "a".repeat(64), acceptLocalErasure: true,
    });
    expect(result.cleanup_pending).toBe(true);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("keeps an older unaccepted cleanup behind the recovery gate", async () => {
    mocks.deletion.mockResolvedValue({
      success: true, account_deleted: false, cleanup_pending: true,
      cleanup_operation: {
        id: "22222222-2222-2222-2222-222222222222", owner_id: "user_123",
        local_erasure_confirmation_required: true,
      },
    });
    await expect(executeLostVaultAccountDeletion({
      userId: "user_123", sessionUser: makeSessionUser(), firebaseIdToken: "fresh-provider",
      reviewedInventorySha256: "a".repeat(64), acceptLocalErasure: true,
    })).rejects.toHaveProperty("code", "ACCOUNT_DELETION_PENDING");
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("keeps a stale recovery rejection before erasure recoverable without sign-out or retry", async () => {
    const failure = new ApiError("Recovery ended", 403, {detail: {code: "PHONE_RECOVERY_PREVIOUS_SIGN_IN_REQUIRED"}});
    mocks.deletion.mockRejectedValueOnce(failure);
    await expect(executeLostVaultAccountDeletion({userId: "user_123", sessionUser: makeSessionUser(),
      firebaseIdToken: "fresh-provider", continuationId: "27b517dc-d694-44e3-a9be-ed8ae0484de2"})).rejects.toBe(failure);
    expect(mocks.deletion).toHaveBeenCalledOnce();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(isAccountDeletionActive("user_123")).toBe(false);
  });

});

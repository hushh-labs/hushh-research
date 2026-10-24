import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ deletion: vi.fn(), dispatch: vi.fn(), clear: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/services/account-service", () => ({ AccountService: { deleteLostVaultAccount: mocks.deletion } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: { onAccountDeleted: vi.fn() } }));
vi.mock("@/lib/services/user-local-state-service", () => ({ UserLocalStateService: { clearForUser: mocks.clear, clearDeviceSecretsForDeletedAccount: vi.fn() } }));
vi.mock("@/lib/services/onboarding-route-cookie", () => ({ setOnboardingRequiredCookie: vi.fn(), setOnboardingFlowActiveCookie: vi.fn() }));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: {} }));
vi.mock("@/lib/auth/session-invalidation", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/auth/session-invalidation")>()), dispatchAuthSessionInvalidated: mocks.dispatch, publishAccountDeletionToSiblingTabs: mocks.publish }));
import { executeLostVaultAccountDeletion } from "@/lib/flows/delete-account";
import { isAccountDeletionActive } from "@/lib/auth/account-deletion-activity";
const makeSessionUser = () => ({ uid: "user_123", getIdToken: vi.fn(async () => "synthetic-token") });
describe("lost-vault deletion submission and terminal outcomes", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.clear.mockResolvedValue(undefined); });
  it.each([
    [true, "account_deleted_ready_to_start_fresh"],
    [false, "account_deletion_finishing"],
  ])("reports locked-vault deletion readiness %s at sign-out", async (ready, code) => {
    mocks.deletion.mockResolvedValue({
      success: true,
      account_deleted: true,
      ready_to_start_fresh: ready,
    });

    await executeLostVaultAccountDeletion({
      userId: "user_123",
      sessionUser: makeSessionUser(),
      firebaseIdToken: "fresh-provider-token",
    });

    expect(mocks.deletion).toHaveBeenCalledWith({
      firebaseIdToken: "fresh-provider-token",
      phoneIdToken: undefined,
    });
    expect(mocks.dispatch).toHaveBeenCalledWith({
      code,
      path: "account_delete_confirmed",
      userId: "user_123",
    });
  });
  it("aborts lost-vault deletion when its initiating session changes during token capture", async () => {
    let resolve!: (value: string) => void;
    const token = new Promise<string>(done => { resolve = done; });
    let current = true;
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
    expect(mocks.dispatch).toHaveBeenCalledWith({ code: "account_deletion_identity_retained", path: "account_delete_confirmed", userId: "user_123" });
    expect(mocks.clear).toHaveBeenCalledWith("user_123", { deleteDurableReceipts: true });
    expect(mocks.publish).toHaveBeenCalledWith("user_123");
  });

});

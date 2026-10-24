import { vi } from "vitest";

const {
  mockDeleteAccount,
  mockDeleteLostVaultAccount,
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
} = vi.hoisted(() => ({
  mockDeleteAccount: vi.fn(),
  mockDeleteLostVaultAccount: vi.fn(),
  mockOnAccountDeleted: vi.fn(),
  mockClearForUser: vi.fn(),
  mockClearDeviceSecrets: vi.fn(),
  mockSetOnboardingRequiredCookie: vi.fn(),
  mockSetOnboardingFlowActiveCookie: vi.fn(),
  mockPublishAccountDeletionToSiblingTabs: vi.fn(),
  mockDispatchAuthSessionInvalidated: vi.fn(),
  mockBackendInvalidationCode: vi.fn(),
  mockFirebaseInvalidationCode: vi.fn(),
  mockGetAccountSessionStatus: vi.fn(),
  mockRevokeAllVaultPlaid: vi.fn(),
  mockSnapshotOwner: vi.fn(),
  mockOwnerIsCurrent: vi.fn(),
  mockRequireVerification: vi.fn(),
}));

export {
  mockDeleteAccount,
  mockDeleteLostVaultAccount,
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
};

vi.mock("@/lib/auth/session-owner", () => ({
  snapshotValidatedAuthSessionOwner: mockSnapshotOwner,
  isValidatedAuthSessionOwnerCurrent: mockOwnerIsCurrent,
  dispatchAuthSessionVerificationRequired: mockRequireVerification,
}));

vi.mock("@/lib/kai/plaid-vault/vault-sync", () => ({
  revokeAllVaultPlaidAtPlaid: mockRevokeAllVaultPlaid,
}));

vi.mock("@/lib/auth/session-invalidation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/session-invalidation")>(),
  ACCOUNT_DELETION_OUTCOME_UNCERTAIN_MESSAGE:
    "We couldn't confirm whether account deletion finished. For your security, we signed you out and won't retry it automatically. Please check your connection before signing in again.",
  AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE: "AUTH_ACCOUNT_NOT_FOUND",
  publishAccountDeletionToSiblingTabs: mockPublishAccountDeletionToSiblingTabs,
  dispatchAuthSessionInvalidated: mockDispatchAuthSessionInvalidated,
  authSessionInvalidationCodeFromBackendPayload: mockBackendInvalidationCode,
  authSessionInvalidationCodeFromFirebaseError: mockFirebaseInvalidationCode,
}));

vi.mock("@/lib/services/account-service", () => ({
  AccountService: {
    deleteAccount: mockDeleteAccount,
    deleteLostVaultAccount: mockDeleteLostVaultAccount,
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getAccountSessionStatus: mockGetAccountSessionStatus },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onAccountDeleted: mockOnAccountDeleted },
}));

vi.mock("@/lib/services/user-local-state-service", () => ({
  UserLocalStateService: {
    clearForUser: mockClearForUser,
    clearDeviceSecretsForDeletedAccount: mockClearDeviceSecrets,
  },
}));

vi.mock("@/lib/services/onboarding-route-cookie", () => ({
  setOnboardingRequiredCookie: mockSetOnboardingRequiredCookie,
  setOnboardingFlowActiveCookie: mockSetOnboardingFlowActiveCookie,
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {},
}));


export function makeSessionUser(uid = "user_123") {
  return {
    uid,
    getIdToken: vi.fn().mockResolvedValue("firebase-token"),
  };
}

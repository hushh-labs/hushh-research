import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  platform: "web" as string,
  options: vi.fn(), review: vi.fn(), reauthenticate: vi.fn(),
  deleteAccount: vi.fn(), signOut: vi.fn(),
}));
vi.mock("@capacitor/core", async original => ({
  ...await original<typeof import("@capacitor/core")>(),
  Capacitor: { isNativePlatform: () => ports.platform !== "web", getPlatform: () => ports.platform, isPluginAvailable: () => false },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({
  resolveVerifiedPhoneNumber: async () => null, signOut: ports.signOut,
}) }));
vi.mock("@/lib/services/account-service", () => ({ AccountService: {
  getLostVaultDeleteOptions: ports.options, reviewLostVaultDeletion: ports.review,
} }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: {
  reauthenticateAccountDeletionIdentity: ports.reauthenticate,
} }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));
vi.mock("@/lib/auth/google-signup-token", () => ({ preloadGoogleSignupAuth: async () => {} }));
vi.mock("@/lib/firebase/config", () => ({ resetRecaptcha: () => {} }));
vi.mock("@/lib/flows/delete-account", () => ({
  executeLostVaultAccountDeletion: ports.deleteAccount,
  lostVaultDeletionErrorMessage: () => "Verify again.",
}));

import { LostVaultDeletePanel } from "@/components/vault/lost-vault-delete-panel";
import { publishValidatedAuthSessionOwner, publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

const firebaseUid = "shared-firebase-uid";
const accountOwnerId = `acct_${"1".repeat(32)}`;
const user = { uid: firebaseUid, getIdToken: vi.fn(async () => "session-token") } as unknown as Parameters<typeof LostVaultDeletePanel>[0]["user"];

beforeEach(() => {
  vi.resetAllMocks();
  ports.platform = "web";
  vi.spyOn(window, "focus").mockImplementation(() => {});
  publishValidatedAuthSessionPrincipal({ firebaseUid, ownerId: accountOwnerId, accountGeneration: 1 });
  ports.options.mockResolvedValue({ phone_available: false, phone_hint: null, providers: ["google.com"] });
  ports.reauthenticate.mockResolvedValue("fresh-provider-token");
  ports.review.mockResolvedValue({ inventory_sha256: "a".repeat(64), credential_count: 1, local_erasure_required: true });
  ports.deleteAccount.mockResolvedValue({
    success: true, account_deleted: false, cleanup_pending: true,
    cleanup_operation: { id: "11111111-1111-1111-1111-111111111111", owner_id: accountOwnerId,
      local_erasure_confirmation_required: false },
  });
  ports.signOut.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); publishValidatedAuthSessionOwner(null); });

it.each(["web", "ios", "android"])("uses reviewed consent and exits pending cleanup on %s", async (platform) => {
  ports.platform = platform;
  render(<LostVaultDeletePanel user={user} onBack={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));
  expect(await screen.findByText(/Shared provider access and external keys remain valid/)).toBeVisible();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Permanently delete account" }));
  await waitFor(() => expect(ports.signOut).toHaveBeenCalledWith({
    redirectTo: "/login?auth_notice=account_deletion_requested",
    expectedUserId: accountOwnerId,
  }));
  expect(ports.deleteAccount).toHaveBeenCalledWith(expect.objectContaining({
    userId: accountOwnerId,
    reviewedInventorySha256: "a".repeat(64),
    acceptLocalErasure: true,
  }));
  expect(screen.queryByText(/Your old account is deleted/)).toBeNull();
});

it("keeps the pending message truthful if sign-out cannot complete", async () => {
  ports.signOut.mockRejectedValueOnce(new Error("sign-out unavailable"));
  render(<LostVaultDeletePanel user={user} onBack={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Permanently delete account" }));
  expect(await screen.findByText(/Deletion requested\. Cleanup continues/)).toBeVisible();
  expect(screen.queryByText(/Your information is deleted/)).toBeNull();
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  resolvePhone: vi.fn(),
  reauthenticate: vi.fn(),
  startPhoneProof: vi.fn(),
  getPhoneClaim: vi.fn(),
  deleteAccount: vi.fn(),
  prepareRecaptcha: vi.fn(),
  resetRecaptcha: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ resolveVerifiedPhoneNumber: mocks.resolvePhone }),
}));
vi.mock("@/lib/services/account-service", () => ({
  AccountService: { getLostVaultDeleteOptions: mocks.options },
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    reauthenticateAccountDeletionIdentity: mocks.reauthenticate,
    startPhoneDeletionVerification: mocks.startPhoneProof,
    getPhoneClaimIdToken: mocks.getPhoneClaim,
  },
}));
vi.mock("@/lib/firebase/config", () => ({
  prepareRecaptchaVerifier: mocks.prepareRecaptcha,
  resetRecaptcha: mocks.resetRecaptcha,
}));
vi.mock("@/lib/flows/delete-account", () => ({
  executeLostVaultAccountDeletion: mocks.deleteAccount,
  lostVaultDeletionErrorMessage: () => "Deletion did not finish. Try again.",
}));

import { LostVaultDeletePanel } from "@/components/vault/lost-vault-delete-panel";

const user = {
  uid: "owner-1",
  getIdToken: vi.fn(async () => "current-session-token"),
} as unknown as Parameters<typeof LostVaultDeletePanel>[0]["user"];

describe("lost vault deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePhone.mockResolvedValue(null);
    mocks.reauthenticate.mockResolvedValue("fresh-provider-token");
    mocks.startPhoneProof.mockResolvedValue("verification-id");
    mocks.getPhoneClaim.mockResolvedValue("phone-proof-token");
    mocks.prepareRecaptcha.mockResolvedValue({});
    mocks.deleteAccount.mockResolvedValue({ success: true, account_deleted: true, ready_to_start_fresh: true });
  });

  it("requires fresh provider proof and explicit loss acknowledgement before deleting a no-phone account", async () => {
    mocks.options.mockResolvedValue({ phone_available: false, phone_hint: null, providers: ["google.com"] });
    render(<LostVaultDeletePanel user={user} onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));
    await screen.findByRole("button", { name: "Permanently delete account" });
    expect(screen.getByRole("button", { name: "Permanently delete account" })).toBeDisabled();
    expect(mocks.deleteAccount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox"));
    const deleteButton = screen.getByRole("button", { name: "Permanently delete account" });
    act(() => {
      fireEvent.click(deleteButton);
      fireEvent.click(deleteButton);
    });

    await waitFor(() => expect(mocks.deleteAccount).toHaveBeenCalledWith({
      userId: "owner-1",
      sessionUser: user,
      firebaseIdToken: "fresh-provider-token",
      phoneIdToken: undefined,
    }));
    expect(mocks.deleteAccount).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("link", { name: "Create a new account" })).toHaveAttribute("href", "/login");
  });

  it("requires proof from the previously linked phone and withholds fresh start while identity removal is pending", async () => {
    mocks.options.mockResolvedValue({ phone_available: true, phone_hint: "••00", providers: ["google.com"] });
    mocks.resolvePhone.mockResolvedValue("+16505550100");
    mocks.deleteAccount.mockResolvedValue({ success: true, account_deleted: true, ready_to_start_fresh: false });
    render(<LostVaultDeletePanel user={user} onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send code" }));
    await waitFor(() => expect(mocks.startPhoneProof).toHaveBeenCalledWith("+16505550100", {}));
    expect(mocks.deleteAccount).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    await screen.findByRole("button", { name: "Permanently delete account" });
    expect(mocks.getPhoneClaim).toHaveBeenCalledWith({ verificationCode: "123456", verificationId: "verification-id" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete account" }));

    await waitFor(() => expect(mocks.deleteAccount).toHaveBeenCalledWith({
      userId: "owner-1",
      sessionUser: user,
      firebaseIdToken: "fresh-provider-token",
      phoneIdToken: "phone-proof-token",
    }));
    expect(screen.queryByRole("link", { name: "Create a new account" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("finishing account removal");
  });
});

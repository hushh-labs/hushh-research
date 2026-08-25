import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KycIdentityPreface } from "@/components/onboarding/setup/kyc-identity-preface";
import { KycIdentityProfilePkmService } from "@/lib/services/kyc-identity-profile-pkm-service";

const mocks = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  vault: {
    isVaultUnlocked: false,
    vaultKey: null as string | null,
    vaultOwnerToken: null as string | null,
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "user_1" } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => mocks.vault }));
vi.mock("@/lib/services/kyc-identity-profile-pkm-service", () => ({
  KycIdentityProfilePkmService: { saveProfile: mocks.saveProfile },
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Vault setup</div> : null,
}));
vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

function enterIdentityForm(): void {
  const continueButton = screen.queryByRole("button", { name: "Continue" });
  if (continueButton) fireEvent.click(continueButton);
}

describe("KycIdentityPreface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.vault.isVaultUnlocked = false;
    mocks.vault.vaultKey = null;
    mocks.vault.vaultOwnerToken = null;
    mocks.saveProfile.mockResolvedValue({ success: true });
  });

  it("keeps KYC on screen and opens vault setup before writing sensitive information", () => {
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    enterIdentityForm();
    fireEvent.change(screen.getByLabelText("Tell us about yourself"), {
      target: { value: "Product designer in Pune, settling estate matters." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & Continue" }));

    expect(onComplete).not.toHaveBeenCalled();
    expect(KycIdentityProfilePkmService.saveProfile).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("continues immediately and reports the actual background import result", async () => {
    mocks.vault.isVaultUnlocked = true;
    mocks.vault.vaultKey = "vault-key";
    mocks.vault.vaultOwnerToken = "owner-token";
    let finishSave: ((result: { success: boolean; message?: string }) => void) | null = null;
    mocks.saveProfile.mockImplementationOnce(
      () => new Promise((resolve) => { finishSave = resolve; }),
    );
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    enterIdentityForm();
    fireEvent.change(screen.getByLabelText("Tell us about yourself"), {
      target: { value: "I study engineering and enjoy Rocket League." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & Continue" }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith("Saving your details to Memory in the background…");
    finishSave?.({ success: true, message: "Saved 2 separate memory details." });
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Saved 2 separate memory details.");
    });
  });
});

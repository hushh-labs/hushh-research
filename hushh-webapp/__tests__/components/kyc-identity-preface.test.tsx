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

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mocks.vault,
}));

vi.mock("@/lib/services/kyc-identity-profile-pkm-service", () => ({
  KycIdentityProfilePkmService: {
    saveProfile: mocks.saveProfile,
  },
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

describe("KycIdentityPreface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.vault.isVaultUnlocked = false;
    mocks.vault.vaultKey = null;
    mocks.vault.vaultOwnerToken = null;
    window.sessionStorage.clear();
    mocks.saveProfile.mockResolvedValue({ success: true });
  });

  it("renders inside the capability cinematic body without the legacy fullscreen shell", () => {
    const { container } = render(
      <KycIdentityPreface onComplete={vi.fn()} />,
    );

    expect(
      container.querySelector('[data-capability-cinematic-intro="email"]'),
    ).toBeInTheDocument();
    const shell = container.querySelector(
      '[data-fullscreen-flow-shell="true"]',
    );
    expect(shell).not.toBeInTheDocument();
  });

  it("requires vault setup before KYC can continue or save", () => {
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      screen.getByRole("button", { name: "Save & Continue" }),
    ).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Tell us about yourself"), {
      target: { value: "  Product designer in Pune, settling estate matters. " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & Continue" }));

    expect(onComplete).not.toHaveBeenCalled();
    expect(KycIdentityProfilePkmService.saveProfile).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("lets a user skip KYC setup without writing a partial identity profile", () => {
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByRole("button", { name: "Skip identity checks" }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(KycIdentityProfilePkmService.saveProfile).not.toHaveBeenCalled();
  });

  it("continues immediately while an unlocked-vault import saves in the background", async () => {
    mocks.vault.isVaultUnlocked = true;
    mocks.vault.vaultKey = "vault-key";
    mocks.vault.vaultOwnerToken = "owner-token";
    let finishSave: ((result: { success: boolean }) => void) | null = null;
    mocks.saveProfile.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Tell us about yourself"), {
      target: { value: "I study engineering and enjoy Rocket League." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save & Continue" }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(mocks.saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
    }));
    expect(mocks.toastInfo).toHaveBeenCalledWith("Saving your details to Memory in the background…");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    finishSave?.({ success: true, message: "Saved 2 separate memory details." });
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Saved 2 separate memory details.");
    });
  });
});

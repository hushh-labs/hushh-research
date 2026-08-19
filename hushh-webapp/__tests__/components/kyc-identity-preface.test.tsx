import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KycIdentityPreface } from "@/components/onboarding/setup/kyc-identity-preface";
import { KycIdentityProfilePkmService } from "@/lib/services/kyc-identity-profile-pkm-service";

const mocks = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  saveNarrative: vi.fn(),
  toastError: vi.fn(),
  vault: {
    isVaultUnlocked: true,
    vaultKey: "vault-key" as string | null,
    vaultOwnerToken: "owner-token" as string | null,
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

vi.mock("@/lib/services/kyc-identity-memory-ingestion-service", () => ({
  saveKycIdentityNarrativeInBackground: mocks.saveNarrative,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
  },
}));

function advanceToIdentityForm(): void {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("KycIdentityPreface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mocks.saveProfile.mockResolvedValue({ success: true });
    mocks.saveNarrative.mockResolvedValue({
      attempted: 1,
      saved: 1,
      failed: 0,
    });
    mocks.vault.isVaultUnlocked = true;
    mocks.vault.vaultKey = "vault-key";
    mocks.vault.vaultOwnerToken = "owner-token";
  });

  it("keeps the capability cinematic introduction before the identity form", () => {
    const { container } = render(<KycIdentityPreface onComplete={vi.fn()} />);

    expect(
      container.querySelector('[data-capability-cinematic-intro="email"]'),
    ).toBeInTheDocument();

    advanceToIdentityForm();
    expect(screen.getByLabelText("Tell us about yourself")).toBeInTheDocument();
  });

  it("starts background PKM extraction after the vault-backed identity write", async () => {
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    advanceToIdentityForm();

    fireEvent.change(screen.getByLabelText("Tell us about yourself"), {
      target: {
        value: "  Product designer in Pune, settling estate matters. ",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & Continue" }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(KycIdentityProfilePkmService.saveProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_1",
          vaultKey: "vault-key",
          vaultOwnerToken: "owner-token",
          profile: {
            aboutMe: "Product designer in Pune, settling estate matters.",
          },
        }),
      );
      expect(mocks.saveNarrative).toHaveBeenCalledWith({
        userId: "user_1",
        narrative: "Product designer in Pune, settling estate matters.",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      });
    });
  });

  it("refuses to retain identity input when a caller bypasses the vault gate", () => {
    mocks.vault.isVaultUnlocked = false;
    mocks.vault.vaultKey = null;
    mocks.vault.vaultOwnerToken = null;
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    advanceToIdentityForm();

    fireEvent.change(screen.getByLabelText("Tell us about yourself"), {
      target: { value: "Product designer in Pune" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & Continue" }));

    expect(onComplete).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Set up your private vault before continuing with KYC.",
    );
    expect(KycIdentityProfilePkmService.saveProfile).not.toHaveBeenCalled();
  });

  it("lets a user skip KYC setup without writing a partial identity profile", () => {
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    advanceToIdentityForm();

    fireEvent.click(screen.getByRole("button", { name: "Skip KYC setup" }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(KycIdentityProfilePkmService.saveProfile).not.toHaveBeenCalled();
  });
});

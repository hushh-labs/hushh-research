import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KycIdentityPreface } from "@/components/onboarding/setup/kyc-identity-preface";
import { KycIdentityProfilePkmService } from "@/lib/services/kyc-identity-profile-pkm-service";

const mocks = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "user_1" } }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: "vault-key",
    vaultOwnerToken: "owner-token",
  }),
}));

vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));

vi.mock("@/components/app-ui/onboarding-stepper", () => ({
  OnboardingStepper: ({ currentIndex }: { currentIndex: number }) => (
    <div data-testid="onboarding-stepper">Step {currentIndex + 1}</div>
  ),
}));

vi.mock("@/lib/services/kyc-identity-profile-pkm-service", () => ({
  KycIdentityProfilePkmService: {
    saveProfile: mocks.saveProfile,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

describe("KycIdentityPreface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveProfile.mockResolvedValue({ success: true });
  });

  it("collects the three identity fields and saves them to the encrypted identity domain", async () => {
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText("Legal name"), {
      target: { value: "Avery Example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByLabelText("Date of birth")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Date of birth"), {
      target: { value: "1994-04-15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    fireEvent.change(screen.getByLabelText("Primary residence"), {
      target: { value: "IN" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() => {
      expect(KycIdentityProfilePkmService.saveProfile).toHaveBeenCalledWith({
        userId: "user_1",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
        profile: {
          legalName: "Avery Example",
          dateOfBirth: "1994-04-15",
          countryCode: "IN",
          countryName: "India",
        },
      });
    });
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Identity details saved to your private vault.",
    );
  });
});

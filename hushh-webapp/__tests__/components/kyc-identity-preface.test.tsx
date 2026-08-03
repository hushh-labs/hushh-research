import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KycIdentityPreface } from "@/components/onboarding/setup/kyc-identity-preface";
import {
  KycIdentityProfileDraftService,
  KycIdentityProfilePkmService,
} from "@/lib/services/kyc-identity-profile-pkm-service";

const mocks = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  stageProfile: vi.fn(),
  toastError: vi.fn(),
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
  KycIdentityProfileDraftService: {
    stage: mocks.stageProfile,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
  },
}));

describe("KycIdentityPreface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mocks.saveProfile.mockResolvedValue({ success: true });
  });

  it("stages four identity answers in memory without opening the vault", async () => {
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.change(screen.getByLabelText("Legal name"), {
      target: { value: "Avery Example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByLabelText("Date of birth")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Date of birth"), {
      target: { value: "1994-04-15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    fireEvent.change(screen.getByLabelText("Country of citizenship"), {
      target: { value: "IN" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    fireEvent.change(screen.getByLabelText("Employment status"), {
      target: { value: "employed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(onComplete).toHaveBeenCalledTimes(1);

    expect(KycIdentityProfileDraftService.stage).toHaveBeenCalledWith(
      "user_1",
      {
        legalName: "Avery Example",
        dateOfBirth: "1994-04-15",
        citizenshipCountryCode: "IN",
        citizenshipCountryName: "India",
        employmentStatus: "employed",
      },
    );
    expect(KycIdentityProfilePkmService.saveProfile).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lets a user skip questions without writing a partial identity profile", () => {
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByRole("button", { name: "Skip this question" }));
    expect(screen.getByLabelText("Date of birth")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Skip this question" }));
    expect(screen.getByLabelText("Country of citizenship")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Skip this question" }));
    expect(screen.getByLabelText("Employment status")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Skip KYC setup" }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(KycIdentityProfilePkmService.saveProfile).not.toHaveBeenCalled();
    expect(KycIdentityProfileDraftService.stage).not.toHaveBeenCalled();
  });
});

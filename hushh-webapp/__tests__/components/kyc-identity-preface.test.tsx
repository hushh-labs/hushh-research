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

  it("stages the about-me summary in memory without opening the vault", () => {
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

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(KycIdentityProfileDraftService.stage).toHaveBeenCalledWith(
      "user_1",
      {
        aboutMe: "Product designer in Pune, settling estate matters.",
      },
    );
    expect(KycIdentityProfilePkmService.saveProfile).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lets a user skip KYC setup without writing a partial identity profile", () => {
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByRole("button", { name: "Skip KYC setup" }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(KycIdentityProfilePkmService.saveProfile).not.toHaveBeenCalled();
    expect(KycIdentityProfileDraftService.stage).not.toHaveBeenCalled();
  });
});

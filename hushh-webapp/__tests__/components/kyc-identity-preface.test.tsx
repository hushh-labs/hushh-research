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

// Both tests below exercise the vault-locked path deliberately ("without
// opening the vault") -- the component stages the draft in memory instead of
// saving to the PKM vault whenever isVaultUnlocked/vaultKey/vaultOwnerToken
// aren't all present.
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: false,
    vaultKey: null,
    vaultOwnerToken: null,
  }),
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

  it("keeps the shared gutter while removing the standard route's duplicate top offset", () => {
    const { container } = render(
      <KycIdentityPreface onComplete={vi.fn()} />,
    );

    expect(
      container.querySelector('[data-capability-cinematic-intro="email"]'),
    ).toBeInTheDocument();
    const shell = container.querySelector(
      '[data-fullscreen-flow-shell="true"]',
    );
    expect(shell).toBeInTheDocument();
    expect(shell?.className).toContain("!pt-0");
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

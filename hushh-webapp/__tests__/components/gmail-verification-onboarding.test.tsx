import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GmailVerificationOnboarding } from "@/components/gmail/gmail-verification-onboarding";

const mocks = vi.hoisted(() => ({
  getStaleFirst: vi.fn(),
  saveProfile: vi.fn(),
  hasCompletedKycIdentityIntake: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { getStaleFirst: mocks.getStaleFirst },
}));
vi.mock("@/lib/services/kyc-identity-profile-pkm-service", () => ({
  hasCompletedKycIdentityIntake: mocks.hasCompletedKycIdentityIntake,
  KycIdentityProfilePkmService: { saveProfile: mocks.saveProfile },
}));
vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

describe("GmailVerificationOnboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStaleFirst.mockResolvedValue({ data: {} });
    mocks.hasCompletedKycIdentityIntake.mockReturnValue(false);
    mocks.saveProfile.mockResolvedValue({ success: true, message: "KYC details saved privately." });
  });

  it("continues to KYC immediately while the PKM save runs in the background", async () => {
    let finishSave: ((result: { success: boolean; message?: string }) => void) | null = null;
    mocks.saveProfile.mockImplementationOnce(
      () => new Promise((resolve) => { finishSave = resolve; }),
    );
    const onDetailsChange = vi.fn();

    render(
      <GmailVerificationOnboarding
        userId="user_1"
        vaultKey="vault-key"
        vaultOwnerToken="owner-token"
        onRequestVaultUnlock={vi.fn()}
        deferred={false}
        onDeferredChange={vi.fn()}
        details="Full name: Example Person"
        onDetailsChange={onDetailsChange}
      >
        <div>KYC workspace</div>
      </GmailVerificationOnboarding>,
    );

    await screen.findByRole("button", { name: "Save KYC details" });
    fireEvent.click(screen.getByRole("button", { name: "Save KYC details" }));

    expect(screen.getByText("KYC workspace")).toBeInTheDocument();
    expect(onDetailsChange).toHaveBeenCalledWith("");
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Saving your KYC details privately in the background…",
    );
    expect(mocks.saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1",
      profile: { aboutMe: "Full name: Example Person" },
    }));

    finishSave?.({ success: true, message: "Saved 1 KYC detail." });
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Saved 1 KYC detail.");
    });
  });

  it("does not ask again after the durable KYC intake marker is saved", async () => {
    mocks.getStaleFirst.mockResolvedValue({
      data: {
        identity_profile: {
          identity_intake_completed_at: "2026-09-04T12:00:00.000Z",
        },
      },
    });
    mocks.hasCompletedKycIdentityIntake.mockReturnValue(true);

    render(
      <GmailVerificationOnboarding
        userId="user_1"
        vaultKey="vault-key"
        vaultOwnerToken="owner-token"
        onRequestVaultUnlock={vi.fn()}
        deferred={false}
        onDeferredChange={vi.fn()}
        details=""
        onDetailsChange={vi.fn()}
      >
        <div>KYC workspace</div>
      </GmailVerificationOnboarding>,
    );

    expect(await screen.findByText("KYC workspace")).toBeInTheDocument();
    expect(screen.queryByText("Build your KYC profile")).not.toBeInTheDocument();
    expect(mocks.getStaleFirst).toHaveBeenCalledWith(expect.objectContaining({
      forceRefresh: true,
      backgroundRefresh: false,
    }));
  });

  it("keeps the person in KYC and reports a background PKM failure", async () => {
    mocks.saveProfile.mockResolvedValueOnce({ success: false });

    render(
      <GmailVerificationOnboarding
        userId="user_1"
        vaultKey="vault-key"
        vaultOwnerToken="owner-token"
        onRequestVaultUnlock={vi.fn()}
        deferred={false}
        onDeferredChange={vi.fn()}
        details="Full name: Example Person"
        onDetailsChange={vi.fn()}
      >
        <div>KYC workspace</div>
      </GmailVerificationOnboarding>,
    );

    await screen.findByRole("button", { name: "Save KYC details" });
    fireEvent.click(screen.getByRole("button", { name: "Save KYC details" }));

    expect(screen.getByText("KYC workspace")).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "We couldn't save your KYC details to Memory. Nothing new was added.",
      );
    });
  });
});

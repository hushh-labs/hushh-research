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

  it("keeps the setup check accessible with a visible KYC workspace placeholder", async () => {
    let finishCheck!: (snapshot: { data: Record<string, unknown> }) => void;
    mocks.getStaleFirst.mockReturnValueOnce(new Promise((resolve) => { finishCheck = resolve; }));
    const { container } = render(
      <GmailVerificationOnboarding userId="user_1" vaultKey="vault-key" vaultOwnerToken="owner-token"
        onRequestVaultUnlock={vi.fn()} deferred={false} onDeferredChange={vi.fn()}
        details="" onDetailsChange={vi.fn()}>
        <div>KYC workspace</div>
      </GmailVerificationOnboarding>,
    );
    expect(screen.getByLabelText("Checking KYC setup")).toBeVisible();
    expect(screen.getByText("Getting your KYC workspace ready.")).toBeVisible();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("Build your KYC profile")).not.toBeInTheDocument();
    expect(screen.queryByText("KYC workspace")).not.toBeInTheDocument();
    finishCheck({ data: {} });
    expect(await screen.findByText("Build your KYC profile")).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole("button", { name: "Paste details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save profile" }));

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

    fireEvent.click(await screen.findByRole("button", { name: "Paste details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save profile" }));

    expect(screen.getByText("KYC workspace")).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "We couldn't save your KYC details to Memory. Nothing new was added.",
      );
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("shows the intro card first and keeps the paste form behind it", async () => {
    render(
      <GmailVerificationOnboarding userId="user_1" vaultKey="vault-key" vaultOwnerToken="owner-token"
        onRequestVaultUnlock={vi.fn()} deferred={false} onDeferredChange={vi.fn()}
        details="" onDetailsChange={vi.fn()}>
        <div>KYC workspace</div>
      </GmailVerificationOnboarding>,
    );

    expect(await screen.findByText("Build your KYC profile")).toBeInTheDocument();
    expect(screen.queryByText("KYC Automation")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "KYC details" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Paste details" }));
    expect(await screen.findByRole("textbox", { name: "KYC details" })).toBeVisible();
    expect(screen.getByText("Encrypted with 256-bit AES · Stored in your private vault")).toBeVisible();
  });

  it("keeps Skip for now as the way into the KYC workspace and closing keeps the draft", async () => {
    const onDeferredChange = vi.fn();
    const onDetailsChange = vi.fn();
    render(
      <GmailVerificationOnboarding userId="user_1" vaultKey="vault-key" vaultOwnerToken="owner-token"
        onRequestVaultUnlock={vi.fn()} deferred={false} onDeferredChange={onDeferredChange}
        details="Full name: Example Person" onDetailsChange={onDetailsChange}>
        <div>KYC workspace</div>
      </GmailVerificationOnboarding>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Paste details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "KYC details" })).not.toBeInTheDocument());
    expect(onDeferredChange).not.toHaveBeenCalled();
    expect(onDetailsChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Paste details" }));
    expect(await screen.findByRole("textbox", { name: "KYC details" })).toHaveValue("Full name: Example Person");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onDeferredChange).toHaveBeenCalledWith(true);
    expect(mocks.saveProfile).not.toHaveBeenCalled();
  });
});

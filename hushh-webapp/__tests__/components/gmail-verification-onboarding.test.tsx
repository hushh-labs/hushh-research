import { CacheService } from "@/lib/services/cache-service";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GmailVerificationOnboarding } from "@/components/gmail/gmail-verification-onboarding";
import { ApiService } from "@/lib/services/api-service";
import { publishValidatedAuthSessionOwner, publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

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
  KycIdentityProfilePkmService: { saveProfile: mocks.saveProfile, hasCompletedIntake: mocks.getStaleFirst },
}));
vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

describe("GmailVerificationOnboarding", () => {
  afterEach(() => { publishValidatedAuthSessionOwner(null); vi.restoreAllMocks(); });
  beforeEach(() => {
    advanceVaultSessionEpoch();
    CacheService.getInstance().clear();
    vi.resetAllMocks();
    mocks.getStaleFirst.mockResolvedValue(false);
    mocks.hasCompletedKycIdentityIntake.mockReturnValue(false);
    mocks.saveProfile.mockResolvedValue({ success: true, message: "KYC details saved privately." });
    publishValidatedAuthSessionPrincipal({ firebaseUid: "user_1", ownerId: "user_1", accountGeneration: 1 });
    vi.spyOn(ApiService, "getFirebaseIdTokenForOwner").mockResolvedValue("synthetic-firebase-token");
    vi.spyOn(ApiService, "apiFetch").mockImplementation(async (_url, options) => new Response(JSON.stringify(
      options?.method === "POST" ? { recorded: true } : { enabled: true, generation: "12345678-1234-1234-1234-123456789012" },
    )));
  });

  it.each(["committed", "owner-changed"])("keeps the original KYC attempt private and scoped when %s", async outcome => {
    render(<GmailVerificationOnboarding userId="user_1" vaultKey="vault-key" vaultOwnerToken="owner-token"
      onRequestVaultUnlock={vi.fn()} deferred={false} onDeferredChange={vi.fn()}
      details="PRIVATE_IDENTITY_TEXT" onDetailsChange={vi.fn()}>KYC workspace</GmailVerificationOnboarding>);
    const reports = () => vi.mocked(ApiService.apiFetch).mock.calls
      .filter(([, options]) => options?.method === "POST")
      .map(([, options]) => JSON.parse(String(options?.body)));
    fireEvent.click(await screen.findByRole("button", { name: "Paste details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(reports()).toHaveLength(1));
    expect(reports()[0]).toEqual({ actionId: "kyc.save_profile", phase: "started",
      generation: "12345678-1234-1234-1234-123456789012", operationId: expect.stringMatching(/^[\da-f-]{36}$/i) });
    const observer = mocks.saveProfile.mock.calls[0]![0].onOutcome;
    if (outcome === "owner-changed") publishValidatedAuthSessionOwner("different-owner");
    observer("returned");
    observer("returned");
    if (outcome === "committed") {
      await waitFor(() => expect(reports()).toHaveLength(2));
      expect(reports()[1]).toEqual({ ...reports()[0], phase: "returned" });
    } else {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(reports()).toHaveLength(1);
    }
    expect(JSON.stringify(reports())).not.toMatch(/PRIVATE_IDENTITY_TEXT|vault-key|owner-token|user_1/);
    expect(mocks.saveProfile).toHaveBeenCalledTimes(1);
  });

  it("keeps the setup check accessible with a visible KYC workspace placeholder", async () => {
    let finishCheck!: (completed: boolean) => void;
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
    finishCheck(false);
    expect(await screen.findByText("Build your KYC profile")).toBeInTheDocument();
  });

  it("renders a warm intake result before any network wait on remount", async () => {
    const props = { userId: "warm-owner", vaultKey: "vault-key", vaultOwnerToken: "owner-token",
      onRequestVaultUnlock: vi.fn(), deferred: false, onDeferredChange: vi.fn(), details: "", onDetailsChange: vi.fn() };
    const first = render(<GmailVerificationOnboarding {...props}>KYC workspace</GmailVerificationOnboarding>);
    await screen.findByText("Build your KYC profile");
    first.unmount();
    mocks.getStaleFirst.mockReturnValueOnce(new Promise(() => {}));
    render(<GmailVerificationOnboarding {...props}>KYC workspace</GmailVerificationOnboarding>);
    expect(screen.getByText("Build your KYC profile")).toBeVisible();
    expect(screen.queryByLabelText("Checking KYC setup")).toBeNull();
    expect(mocks.getStaleFirst).toHaveBeenCalledTimes(1);
  });

  it("retires an open intake dialog when its owner changes", async () => {
    const props = { userId: "owner-a", vaultKey: "vault-key-a", vaultOwnerToken: "owner-token-a",
      onRequestVaultUnlock: vi.fn(), deferred: false, onDeferredChange: vi.fn(), details: "", onDetailsChange: vi.fn() };
    const view = render(<GmailVerificationOnboarding {...props}>KYC workspace</GmailVerificationOnboarding>);
    fireEvent.click(await screen.findByRole("button", { name: "Paste details" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    view.rerender(<GmailVerificationOnboarding {...props} userId="owner-b" vaultKey="vault-key-b" vaultOwnerToken="owner-token-b">KYC workspace</GmailVerificationOnboarding>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("KYC workspace")).toBeNull();
    expect(await screen.findByRole("button", { name: "Paste details" })).toBeEnabled();
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
    mocks.getStaleFirst.mockResolvedValue(true);
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
      userId: "user_1", vaultKey: "vault-key", vaultOwnerToken: "owner-token",
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

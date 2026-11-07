import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KycIdentityPreface } from "@/components/onboarding/setup/kyc-identity-preface";
import { KycIdentityProfilePkmService } from "@/lib/services/kyc-identity-profile-pkm-service";
import { ApiService } from "@/lib/services/api-service";
import { publishValidatedAuthSessionOwner, publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  writeText: vi.fn(),
  vault: {
    isVaultUnlocked: false,
    vaultKey: null as string | null,
    vaultOwnerToken: null as string | null,
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "user_1" }, userId: "user_1" }),
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
  afterEach(() => { publishValidatedAuthSessionOwner(null); vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.vault.isVaultUnlocked = false;
    mocks.vault.vaultKey = null;
    mocks.vault.vaultOwnerToken = null;
    mocks.saveProfile.mockResolvedValue({ success: true });
    publishValidatedAuthSessionPrincipal({ firebaseUid: "user_1", ownerId: "user_1", accountGeneration: 1 });
    vi.spyOn(ApiService, "getFirebaseIdTokenForOwner").mockResolvedValue("synthetic-firebase-token");
    vi.spyOn(ApiService, "apiFetch").mockImplementation(async (_url, options) => new Response(JSON.stringify(
      options?.method === "POST" ? { recorded: true } : { enabled: true, generation: "12345678-1234-1234-1234-123456789012" },
    )));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
  });

  it("leads with an external-agent import request", () => {
    render(<KycIdentityPreface onComplete={vi.fn()} />);
    enterIdentityForm();

    expect(
      screen.getByRole("heading", { name: "Import from ChatGPT or another AI" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "1. Copy this request" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2. Paste the response" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy import request" }));

    expect(mocks.writeText).toHaveBeenCalledWith(
      "Can you share one to two pages of the information you have about me for an external agent? Use simple Markdown bullet points under Facts, Preferences, and Commitments. Include any KYC-related information you have, and clearly note anything uncertain or missing. Do not include passwords, PINs, security codes, or authentication keys.",
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Request copied to clipboard.");
  });

  it("keeps KYC on screen and opens vault setup before writing sensitive information", () => {
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    enterIdentityForm();
    fireEvent.change(screen.getByLabelText("Paste your profile export"), {
      target: { value: "Product designer in Pune, settling estate matters." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import & Continue" }));

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
    fireEvent.change(screen.getByLabelText("Paste your profile export"), {
      target: { value: "I study engineering and enjoy Rocket League." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import & Continue" }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith("Importing your profile into Memory in the background…");
    finishSave?.({ success: true, message: "Saved 2 separate memory details." });
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Saved 2 separate memory details.");
    });
  });

  it("pairs a manual setup import only when its original write is acknowledged", async () => {
    mocks.vault.isVaultUnlocked = true;
    mocks.vault.vaultKey = "vault-key";
    mocks.vault.vaultOwnerToken = "owner-token";
    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    enterIdentityForm();
    fireEvent.change(screen.getByLabelText("Paste your profile export"), { target: { value: "PRIVATE_IDENTITY_TEXT" } });
    fireEvent.click(screen.getByRole("button", { name: "Import & Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Import & Continue" }));
    const reports = () => vi.mocked(ApiService.apiFetch).mock.calls
      .filter(([, options]) => options?.method === "POST")
      .map(([, options]) => JSON.parse(String(options?.body)));
    await waitFor(() => expect(reports()).toHaveLength(1));
    expect(reports()[0].phase).toBe("started");
    expect(mocks.saveProfile).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    mocks.saveProfile.mock.calls[0]![0].onOutcome("returned");
    await waitFor(() => expect(reports()).toHaveLength(2));
    expect(reports()[1]).toEqual({ ...reports()[0], actionId: "kyc.save_profile", phase: "returned" });
    expect(JSON.stringify(reports())).not.toMatch(/PRIVATE_IDENTITY_TEXT|vault-key|owner-token|user_1/);
  });
});

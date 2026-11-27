import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KycIdentityPreface } from "@/components/onboarding/setup/kyc-identity-preface";
import {
  buildGuidedExportGoal,
  reduceGuidedExportTerminalSnapshot,
  resolveGuidedBrowserEligibility,
} from "@/lib/files/wiki/guided-export";
import { publishValidatedAuthSessionOwner, publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  uploadFile: vi.fn(),
  wikiImportArchive: vi.fn(),
  withUnlockedFilesConnection: vi.fn(),
  browserCapability: vi.fn(),
  browserStart: vi.fn(),
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
  useAuth: () => ({ user: { uid: "user_1" }, userId: "user_1" }),
}));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => mocks.vault }));
vi.mock("@/lib/services/kyc-identity-profile-pkm-service", () => ({
  isValidDateOfBirth: () => true,
  KycIdentityProfilePkmService: { saveProfile: mocks.saveProfile },
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Vault setup</div> : null,
}));
vi.mock("@/lib/files/service", () => ({
  FilesService: {
    upload: mocks.uploadFile,
    wikiImportArchive: mocks.wikiImportArchive,
  },
}));
vi.mock("@/lib/files/use-files-connection", () => ({
  withUnlockedFilesConnection: mocks.withUnlockedFilesConnection,
}));
vi.mock("@/lib/services/computer-use-client", () => ({
  ComputerUseClient: class {
    capability = mocks.browserCapability;
    start = mocks.browserStart;
    transport = () => ({});
  },
}));
vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

function advanceIntroIfPresent(): void {
  const continueButton = screen.queryByRole("button", { name: "Continue" });
  if (continueButton) fireEvent.click(continueButton);
}

describe("Guided AI Export & Onboarding Archive Import (#9428 / #9429)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.vault.isVaultUnlocked = false;
    mocks.vault.vaultKey = null;
    mocks.vault.vaultOwnerToken = null;
    mocks.withUnlockedFilesConnection.mockImplementation(
      async (_params: unknown, run: (mode: "shared" | "pod") => Promise<unknown>) =>
        run("shared"),
    );
    publishValidatedAuthSessionPrincipal({
      firebaseUid: "user_1",
      ownerId: "user_1",
      accountGeneration: 1,
    });
    publishValidatedAuthSessionOwner({
      userId: "user_1",
      accountGeneration: 1,
    });
  });

  it("evaluates Browser eligibility and emailed-export terminal transitions truthfully", () => {
    expect(
      resolveGuidedBrowserEligibility({
        available: false,
        code: "BROWSER_CLOUD_GATE_UNAVAILABLE",
      }).eligible,
    ).toBe(false);

    expect(
      resolveGuidedBrowserEligibility({
        available: true,
        code: "BROWSER_QUALIFIED",
        publicResearchOnly: true,
      }),
    ).toMatchObject({
      eligible: false,
      reasonCode: "BROWSER_PUBLIC_RESEARCH_ONLY",
    });

    expect(
      resolveGuidedBrowserEligibility({
        available: true,
        code: "BROWSER_QUALIFIED",
        publicResearchOnly: false,
      }).eligible,
    ).toBe(true);

    expect(
      reduceGuidedExportTerminalSnapshot("browser_active", {
        phase: "completed",
        downloads: [],
      }),
    ).toBe("waiting_for_emailed_export");

    expect(
      reduceGuidedExportTerminalSnapshot("browser_active", {
        phase: "completed",
        downloads: [
          { id: "d1", name: "export.zip", size: 1024, sha256: "a".repeat(64) },
        ],
      }),
    ).toBe("browser_active");

    expect(buildGuidedExportGoal("claude")).toContain("https://claude.ai");
  });

  it("opens vault setup before uploading an archive when the vault is locked", () => {
    render(<KycIdentityPreface onComplete={vi.fn()} />);
    advanceIntroIfPresent();

    const fileInput = screen.getByLabelText("Select ChatGPT or Claude export file");
    const sampleFile = new File(["{}"], "conversations.json", {
      type: "application/json",
    });
    fireEvent.change(fileInput, { target: { files: [sampleFile] } });

    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("Vault setup");
  });

  it("uploads an archive into encrypted Files, compiles Personal Wiki notes, and enables onboarding continuation", async () => {
    mocks.vault.isVaultUnlocked = true;
    mocks.vault.vaultKey = "vault-key-test";
    mocks.vault.vaultOwnerToken = "owner-token-test";
    mocks.uploadFile.mockResolvedValue({ id: "f".repeat(32), state: "ready" });
    mocks.wikiImportArchive.mockResolvedValue({
      provider: "chatgpt",
      fileId: "f".repeat(32),
      pagesUpdated: 2,
      claimsImported: 5,
      claimsDeduplicated: 0,
      claimsSkippedTombstoned: 0,
      candidateCount: 1,
    });

    const onComplete = vi.fn();
    render(<KycIdentityPreface onComplete={onComplete} />);
    advanceIntroIfPresent();

    const fileInput = screen.getByLabelText("Select ChatGPT or Claude export file");
    const sampleFile = new File(["{}"], "chatgpt-export.zip", {
      type: "application/zip",
    });
    fireEvent.change(fileInput, { target: { files: [sampleFile] } });

    await waitFor(() => {
      expect(
        screen.getByText(/Imported 5 notes across 2 Personal Wiki pages/i),
      ).toBeInTheDocument();
    });
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.wikiImportArchive).toHaveBeenCalledWith(
      { fileId: "f".repeat(32), sourceProvider: "chatgpt" },
      expect.any(AbortSignal),
    );

    const continueBtn = screen.getByRole("button", { name: "Import & Continue" });
    expect(continueBtn).not.toBeDisabled();
    fireEvent.click(continueBtn);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("falls back truthfully on Shared hosting and transitions to waiting_for_emailed_export", async () => {
    mocks.vault.isVaultUnlocked = true;
    mocks.vault.vaultKey = "vault-key-test";
    mocks.vault.vaultOwnerToken = "owner-token-test";
    mocks.browserCapability.mockResolvedValue({
      available: false,
      code: "BROWSER_CLOUD_GATE_UNAVAILABLE",
    });

    render(<KycIdentityPreface onComplete={vi.fn()} />);
    advanceIntroIfPresent();

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Guided Claude export" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Guided Browser sign-in requires a Browser-qualified private pod/i),
      ).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: /I requested my export \(waiting for email\)/i,
      }),
    );

    expect(
      screen.getByText("Waiting for emailed export archive"),
    ).toBeInTheDocument();
  });
});

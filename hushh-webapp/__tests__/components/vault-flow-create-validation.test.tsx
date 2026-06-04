import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VaultFlow } from "@/components/vault/vault-flow";

const checkVaultMock = vi.fn();
const getVaultStateMock = vi.fn();
const getPrimaryWrapperMock = vi.fn();
const getWrapperByMethodMock = vi.fn();
const unlockGeneratedDefaultVaultMock = vi.fn();
const unlockVaultMock = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
  },
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    checkVault: (...args: unknown[]) => checkVaultMock(...args),
    getVaultState: (...args: unknown[]) => getVaultStateMock(...args),
    getPrimaryWrapper: (...args: unknown[]) => getPrimaryWrapperMock(...args),
    getWrapperByMethod: (...args: unknown[]) => getWrapperByMethodMock(...args),
    unlockGeneratedDefaultVault: (...args: unknown[]) =>
      unlockGeneratedDefaultVaultMock(...args),
  },
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    unlockVault: unlockVaultMock,
  }),
}));

vi.mock("@/lib/services/vault-method-service", () => ({
  VaultMethodService: {},
}));

vi.mock("@/lib/services/vault-method-prompt-local-service", () => ({
  VaultMethodPromptLocalService: {},
}));

vi.mock("@/lib/utils/native-download", () => ({
  downloadTextFile: vi.fn(),
}));

vi.mock("@/lib/utils/clipboard", () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock("@/lib/utils/browser-navigation", () => ({
  reloadWindow: vi.fn(),
}));

type TestVaultWrapper = {
  method: string;
  encryptedVaultKey: string;
  salt: string;
  iv: string;
  passkeyCredentialId?: string;
  passkeyPrfSalt?: string;
};

type TestVaultState = {
  primaryMethod: string;
  primaryWrapperId?: string;
  wrappers: TestVaultWrapper[];
};

const passphraseWrapper: TestVaultWrapper = {
  method: "passphrase",
  encryptedVaultKey: "encrypted-passphrase",
  salt: "salt-passphrase",
  iv: "iv-passphrase",
};

const passkeyWrapper: TestVaultWrapper = {
  method: "generated_default_web_prf",
  encryptedVaultKey: "encrypted-passkey",
  salt: "salt-passkey",
  iv: "iv-passkey",
  passkeyCredentialId: "credential-1",
  passkeyPrfSalt: "passkey-salt",
};

function vaultState(primaryMethod: string, wrappers: TestVaultWrapper[]): TestVaultState {
  return {
    primaryMethod,
    primaryWrapperId: primaryMethod,
    wrappers,
  };
}

describe("VaultFlow create validation", () => {
  const user = { uid: "user-1" } as Parameters<typeof VaultFlow>[0]["user"];

  beforeEach(() => {
    vi.clearAllMocks();
    checkVaultMock.mockResolvedValue(false);
    getVaultStateMock.mockResolvedValue(
      vaultState("passphrase", [passphraseWrapper, passkeyWrapper]),
    );
    getWrapperByMethodMock.mockImplementation((state: TestVaultState, method: string) => {
      return state.wrappers.find((wrapper) => wrapper.method === method) ?? null;
    });
    getPrimaryWrapperMock.mockImplementation((state: TestVaultState) => {
      return (
        state.wrappers.find((wrapper) => wrapper.method === state.primaryMethod) ??
        state.wrappers[0]
      );
    });
    unlockGeneratedDefaultVaultMock.mockRejectedValue(
      new Error("Quick unlock prompt unavailable in test"),
    );
  });

  it("explains why Create Vault is disabled for short or mismatched passphrases", async () => {
    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /continue to vault setup/i }));

    const passphraseInput = screen.getByLabelText("Passphrase");
    const confirmInput = screen.getByLabelText("Confirm Passphrase");
    const createButton = screen.getByRole("button", { name: "Create Vault" }) as HTMLButtonElement;

    fireEvent.change(passphraseInput, { target: { value: "short" } });
    expect(await screen.findByText("Minimum 8 characters required.")).toBeTruthy();
    expect(createButton.disabled).toBe(true);

    fireEvent.change(passphraseInput, { target: { value: "long-enough" } });
    fireEvent.change(confirmInput, { target: { value: "different" } });
    expect(await screen.findByText("Passphrases do not match.")).toBeTruthy();
    expect(createButton.disabled).toBe(true);
  });

  it("uses compact Vault Key primary copy with Passkey and Recovery Key alternatives", async () => {
    checkVaultMock.mockResolvedValue(true);
    getVaultStateMock.mockResolvedValue(
      vaultState("passphrase", [passphraseWrapper, passkeyWrapper]),
    );

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    expect(await screen.findByLabelText("Vault Key")).toBeTruthy();
    const unlockButton = screen.getByRole("button", { name: "Unlock" }) as HTMLButtonElement;

    expect(unlockButton.disabled).toBe(true);
    expect(screen.getByText("Other methods")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Passkey" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recovery Key" })).toBeTruthy();
  });

  it("uses Vault Key and Recovery Key alternatives when Passkey is primary", async () => {
    checkVaultMock.mockResolvedValue(true);
    getVaultStateMock.mockResolvedValue(
      vaultState("generated_default_web_prf", [passphraseWrapper, passkeyWrapper]),
    );

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    expect(await screen.findByText("Other methods")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Vault Key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recovery Key" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Passkey" })).toBeNull();
  });

  it("keeps recovery unlock compact and returns to available methods", async () => {
    checkVaultMock.mockResolvedValue(true);
    getVaultStateMock.mockResolvedValue(
      vaultState("passphrase", [passphraseWrapper, passkeyWrapper]),
    );

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Recovery Key" }));

    expect(await screen.findByLabelText("Recovery Key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeTruthy();
    expect(screen.getByText("Other methods")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Vault Key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Passkey" })).toBeTruthy();
  });

  it("omits Passkey when no generated unlock method exists", async () => {
    checkVaultMock.mockResolvedValue(true);
    getVaultStateMock.mockResolvedValue(vaultState("passphrase", [passphraseWrapper]));

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    expect(await screen.findByLabelText("Vault Key")).toBeTruthy();
    expect(screen.getByText("Other methods")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Passkey" })).toBeNull();
    expect(screen.getByRole("button", { name: "Recovery Key" })).toBeTruthy();
  });
});

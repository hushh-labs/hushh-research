import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VaultFlow } from "@/components/vault/vault-flow";

const checkVaultMock = vi.fn();
const getVaultStateMock = vi.fn();
const getPrimaryWrapperMock = vi.fn();
const getWrapperByMethodMock = vi.fn();
const unlockGeneratedDefaultVaultMock = vi.fn();
const unlockVaultMock = vi.fn();
const createVaultMock = vi.fn();
const hashVaultKeyMock = vi.fn();
const setupVaultStateMock = vi.fn();
const assertVaultKeyMatchesStateMock = vi.fn();
const setVaultCheckCacheMock = vi.fn();
let isNativePlatformMock = false;

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatformMock,
  },
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    checkVault: (...args: unknown[]) => checkVaultMock(...args),
    getVaultState: (...args: unknown[]) => getVaultStateMock(...args),
    getPrimaryWrapper: (...args: unknown[]) => getPrimaryWrapperMock(...args),
    getWrapperByMethod: (...args: unknown[]) => getWrapperByMethodMock(...args),
    createVault: (...args: unknown[]) => createVaultMock(...args),
    hashVaultKey: (...args: unknown[]) => hashVaultKeyMock(...args),
    setupVaultState: (...args: unknown[]) => setupVaultStateMock(...args),
    assertVaultKeyMatchesState: (...args: unknown[]) =>
      assertVaultKeyMatchesStateMock(...args),
    setVaultCheckCache: (...args: unknown[]) => setVaultCheckCacheMock(...args),
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

const nativePasskeyWrapper: TestVaultWrapper = {
  method: "generated_default_native_passkey_prf",
  encryptedVaultKey: "encrypted-native-passkey",
  salt: "salt-native-passkey",
  iv: "iv-native-passkey",
  passkeyCredentialId: "native-credential-1",
  passkeyPrfSalt: "native-passkey-salt",
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
    isNativePlatformMock = false;
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
    createVaultMock.mockResolvedValue({
      vaultKeyHex: "vault-key",
      encryptedVaultKey: "encrypted-passphrase",
      salt: "salt-passphrase",
      iv: "iv-passphrase",
      recoveryEncryptedVaultKey: "encrypted-recovery",
      recoverySalt: "recovery-salt",
      recoveryIv: "recovery-iv",
      recoveryKey: "recovery-key",
    });
    hashVaultKeyMock.mockResolvedValue("vault-key-hash");
    setupVaultStateMock.mockResolvedValue(undefined);
    assertVaultKeyMatchesStateMock.mockResolvedValue(undefined);
  });

  it("explains why Create Vault is disabled for short or mismatched passphrases", async () => {
    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    const passphraseInput = await screen.findByLabelText("Passphrase");
    const confirmInput = screen.getByLabelText("Confirm passphrase");
    const createButton = screen.getByRole("button", { name: "Create passphrase" }) as HTMLButtonElement;

    // iOS renders `enterKeyHint="done"` as a checkmark on the keyboard.
    // Vault confirmation uses normal submit behavior without adding that glyph.
    expect(confirmInput.getAttribute("enterkeyhint")).toBeNull();

    fireEvent.change(passphraseInput, { target: { value: "short" } });
    expect(await screen.findByText("Minimum 8 characters required.")).toBeTruthy();
    expect(createButton.disabled).toBe(true);

    fireEvent.change(passphraseInput, { target: { value: "long-enough" } });
    fireEvent.change(confirmInput, { target: { value: "different" } });
    expect(await screen.findByText("Passphrases do not match.")).toBeTruthy();
    expect(createButton.disabled).toBe(true);
  });

  it("submits vault creation when Enter is pressed on a valid confirmation", async () => {
    const onRecoveryKeyDisclosureChange = vi.fn();
    const view = render(
      <VaultFlow
        user={user}
        onSuccess={vi.fn()}
        onRecoveryKeyDisclosureChange={onRecoveryKeyDisclosureChange}
      />,
    );

    fireEvent.change(await screen.findByLabelText("Passphrase"), {
      target: { value: "correct horse battery staple" },
    });
    const confirmation = screen.getByLabelText("Confirm passphrase");
    fireEvent.change(confirmation, {
      target: { value: "correct horse battery staple" },
    });

    fireEvent.submit(confirmation.closest("form")!);

    await screen.findByRole("heading", { name: /save your recovery key/i });
    expect(document.querySelector("[data-vault-recovery-key]")).toBeTruthy();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(onRecoveryKeyDisclosureChange).toHaveBeenLastCalledWith(true);
    expect(createVaultMock).toHaveBeenCalledTimes(1);
    expect(createVaultMock).toHaveBeenCalledWith("correct horse battery staple");

    view.unmount();
    expect(onRecoveryKeyDisclosureChange).toHaveBeenLastCalledWith(false);
  });

  it("opens fresh vault creation directly in the canonical credential layout", async () => {
    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    // "Set a lock", not "Create your passphrase": the heading names the job,
    // not the mechanism, and it is the same phrase one-setup-hub already passes
    // as this dialog's accessible title — the screen used to announce one name
    // and show another. "Passphrase" still labels the fields, where it belongs.
    expect(await screen.findByRole("heading", { name: "Set a lock" })).toBeTruthy();
    expect(screen.getByLabelText("Passphrase")).toBeTruthy();
    expect(screen.getByLabelText("Confirm passphrase")).toBeTruthy();
    expect(screen.queryByText("Secure Your Digital Vault")).toBeNull();
    expect(screen.queryByRole("button", { name: /continue to vault setup/i })).toBeNull();
    expect(document.querySelector('[data-vault-flow-step="create"]')).toBeTruthy();
    expect(document.querySelector("[data-vault-flow-icon]")).toHaveClass(
      "bg-[color:var(--app-accent-tint)]",
    );
  });

  it("defers new vault creation until the root setup completion boundary", async () => {
    render(
      <VaultFlow
        user={user}
        onSuccess={vi.fn()}
        allowVaultCreation={false}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Finish setup first" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create passphrase" })).toBeNull();
    expect(createVaultMock).not.toHaveBeenCalled();
  });

  it("uses compact passphrase primary copy with passkey and recovery alternatives", async () => {
    checkVaultMock.mockResolvedValue(true);
    getVaultStateMock.mockResolvedValue(
      vaultState("passphrase", [passphraseWrapper, passkeyWrapper]),
    );

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    expect(await screen.findByLabelText("Vault passphrase")).toBeTruthy();
    const unlockButton = screen.getByRole("button", { name: "Unlock" }) as HTMLButtonElement;

    expect(unlockButton.disabled).toBe(true);
    expect(screen.getByText("Use another method")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Passkey" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recovery key" })).toBeTruthy();
    expect(document.querySelector("[data-vault-flow-icon]")).toHaveClass(
      "bg-[color:var(--app-accent-tint)]",
    );
  });

  it("uses passphrase and recovery alternatives when passkey is primary", async () => {
    checkVaultMock.mockResolvedValue(true);
    getVaultStateMock.mockResolvedValue(
      vaultState("generated_default_web_prf", [passphraseWrapper, passkeyWrapper]),
    );

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    expect(await screen.findByText("Use another method")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Passphrase" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recovery key" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Passkey" })).toBeNull();
  });

  it("keeps recovery unlock compact and returns to available methods", async () => {
    checkVaultMock.mockResolvedValue(true);
    getVaultStateMock.mockResolvedValue(
      vaultState("passphrase", [passphraseWrapper, passkeyWrapper]),
    );

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Recovery key" }));

    expect(await screen.findByLabelText("Recovery Key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeTruthy();
    expect(screen.getByText("Use another method")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Passphrase" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Passkey" })).toBeTruthy();
    expect(document.querySelector("[data-vault-flow-icon]")).toHaveClass(
      "bg-[color:var(--app-accent-tint)]",
    );
  });

  it("omits Passkey when no generated unlock method exists", async () => {
    checkVaultMock.mockResolvedValue(true);
    getVaultStateMock.mockResolvedValue(vaultState("passphrase", [passphraseWrapper]));

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    expect(await screen.findByLabelText("Vault passphrase")).toBeTruthy();
    expect(screen.getByText("Use another method")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Passkey" })).toBeNull();
    expect(screen.getByRole("button", { name: "Recovery key" })).toBeTruthy();
  });

  it("keeps the hard-gate Sign out escape tappable while passkey unlock is pending", async () => {
    isNativePlatformMock = true;
    checkVaultMock.mockResolvedValue(true);
    getVaultStateMock.mockResolvedValue(
      vaultState("generated_default_native_passkey_prf", [
        passphraseWrapper,
        nativePasskeyWrapper,
      ]),
    );
    unlockGeneratedDefaultVaultMock.mockImplementation(() => new Promise(() => {}));
    const onSignOut = vi.fn().mockResolvedValue(undefined);

    render(<VaultFlow user={user} onSuccess={vi.fn()} onSignOut={onSignOut} />);

    expect(await screen.findByText(/Prompting passkey/i)).toBeTruthy();
    const signOutEscape = screen.getByRole("button", {
      name: /can't get in\? sign out/i,
    }) as HTMLButtonElement;
    expect(signOutEscape.disabled).toBe(false);

    fireEvent.click(signOutEscape);

    await waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1));
  });
});

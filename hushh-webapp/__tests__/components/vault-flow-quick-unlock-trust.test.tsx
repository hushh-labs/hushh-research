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
const checkPrfSupportMock = vi.fn();
const getOrIssueVaultOwnerTokenMock = vi.fn();
const unlockWithMethodMock = vi.fn();
const getCapabilityMatrixMock = vi.fn();
let isNativePlatformMock = false;
const cancelAuthenticationMock = vi.fn();

vi.mock("@/lib/services/vault-bootstrap-service", () => ({
  VaultBootstrapService: {
    getBiometricLabel: vi.fn(async () => "Face ID"),
    getDeviceBiometricWrapperId: vi.fn(async () => "default"),
    cancelAuthentication: (...args: unknown[]) => cancelAuthenticationMock(...args),
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatformMock,
  },
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultAuthSessionNotReadyError: class extends Error {},
  VaultService: {
    getOrIssueVaultOwnerToken: (...args: unknown[]) => getOrIssueVaultOwnerTokenMock(...args),
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
    unlockWithMethod: (...args: unknown[]) => unlockWithMethodMock(...args),
  },
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    unlockVault: unlockVaultMock,
  }),
}));

vi.mock("@/lib/services/vault-method-service", () => ({
  VaultMethodService: { getCapabilityMatrix: (...args: unknown[]) => getCapabilityMatrixMock(...args) },
}));

vi.mock("@/lib/services/vault-method-prompt-local-service", () => ({
  VaultMethodPromptLocalService: {},
}));

const trustLoadMock = vi.fn();
const trustMarkMock = vi.fn();
vi.mock("@/lib/services/vault-quick-unlock-trust-local-service", () => ({
  isQuickUnlockTrustRequired: () => true,
  VaultQuickUnlockTrustLocalService: {
    load: (...args: unknown[]) => trustLoadMock(...args),
    mark: (...args: unknown[]) => trustMarkMock(...args),
    clear: vi.fn(),
  },
}));

vi.mock("@/lib/vault/prf-auth", () => ({
  checkPrfSupport: (...args: unknown[]) => checkPrfSupportMock(...args),
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
  passkeyRpId?: string;
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
  passkeyRpId: "one.hushh.ai",
};

const nativePasskeyWrapper: TestVaultWrapper = {
  method: "generated_default_native_passkey_prf",
  encryptedVaultKey: "encrypted-native-passkey",
  salt: "salt-native-passkey",
  iv: "iv-native-passkey",
  passkeyCredentialId: "native-credential-1",
  passkeyPrfSalt: "native-passkey-salt",
  passkeyRpId: "one.hushh.ai",
};

function vaultState(
  primaryMethod: string,
  wrappers: TestVaultWrapper[],
): TestVaultState {
  return {
    primaryMethod,
    primaryWrapperId: primaryMethod,
    wrappers,
  };
}

describe("VaultFlow quick-unlock trust (native: automatic only after a success on this device)", () => {
  const user = { uid: "user-trust" } as Parameters<typeof VaultFlow>[0]["user"];

  beforeEach(() => {
    vi.clearAllMocks();
    cancelAuthenticationMock.mockResolvedValue(undefined);
    isNativePlatformMock = false;
    checkPrfSupportMock.mockResolvedValue(true);
    checkVaultMock.mockResolvedValue(false);
    getVaultStateMock.mockResolvedValue(
      vaultState("passphrase", [passphraseWrapper, passkeyWrapper]),
    );
    getWrapperByMethodMock.mockImplementation(
      (state: TestVaultState, method: string) => {
        return (
          state.wrappers.find((wrapper) => wrapper.method === method) ?? null
        );
      },
    );
    getPrimaryWrapperMock.mockImplementation((state: TestVaultState) => {
      return (
        state.wrappers.find(
          (wrapper) => wrapper.method === state.primaryMethod,
        ) ?? state.wrappers[0]
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

  function nativePasskeyPrimary() {
    isNativePlatformMock = true;
    checkVaultMock.mockResolvedValue(true);
    getVaultStateMock.mockResolvedValue(
      vaultState("generated_default_native_passkey_prf", [
        passphraseWrapper,
        nativePasskeyWrapper,
      ]),
    );
  }

  it("opens on the passphrase form with the passkey one tap away when the device has no record", async () => {
    nativePasskeyPrimary();
    trustLoadMock.mockResolvedValue(null);
    unlockGeneratedDefaultVaultMock.mockImplementation(() => new Promise(() => {}));

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    expect(await screen.findByLabelText("Vault passphrase")).toBeTruthy();
    expect(screen.getByTestId("vault-use-passkey-escape")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(unlockGeneratedDefaultVaultMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Unlocking with passkey/i)).toBeNull();
  });

  it("starts the passkey by itself once the device holds a record for that method", async () => {
    nativePasskeyPrimary();
    trustLoadMock.mockResolvedValue({
      method: "generated_default_native_passkey_prf",
      succeeded_at: "2026-09-21T00:00:00.000Z",
    });
    unlockGeneratedDefaultVaultMock.mockImplementation(() => new Promise(() => {}));

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    expect(await screen.findByText(/Unlocking with passkey/i)).toBeTruthy();
    await waitFor(() => expect(unlockGeneratedDefaultVaultMock).toHaveBeenCalledTimes(1));
    expect(trustLoadMock).toHaveBeenCalledWith("user-trust");
  });

  it("treats a record for another method as no record", async () => {
    nativePasskeyPrimary();
    trustLoadMock.mockResolvedValue({
      method: "generated_default_native_biometric",
      succeeded_at: "2026-09-21T00:00:00.000Z",
    });

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    expect(await screen.findByLabelText("Vault passphrase")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(unlockGeneratedDefaultVaultMock).not.toHaveBeenCalled();
  });

  it("records the device after the passkey unlocks from the button", async () => {
    nativePasskeyPrimary();
    trustLoadMock.mockResolvedValue(null);
    unlockGeneratedDefaultVaultMock.mockResolvedValue("vault-key-hex");
    assertVaultKeyMatchesStateMock.mockResolvedValue(undefined);
    getOrIssueVaultOwnerTokenMock.mockResolvedValue({ token: "HCT:token", expiresAt: 0 });
    unlockVaultMock.mockReturnValue(true);
    const onSuccess = vi.fn();

    render(<VaultFlow user={user} onSuccess={onSuccess} />);

    const escape = await screen.findByTestId("vault-use-passkey-escape");
    expect(unlockGeneratedDefaultVaultMock).not.toHaveBeenCalled();
    fireEvent.click(escape);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(unlockGeneratedDefaultVaultMock).toHaveBeenCalledTimes(1);
    expect(trustMarkMock).toHaveBeenCalledWith("user-trust", "generated_default_native_passkey_prf");
  });

  it("keeps the passkey button visible after a wrong passphrase while the device is untrusted", async () => {
    nativePasskeyPrimary();
    trustLoadMock.mockResolvedValue(null);
    unlockWithMethodMock.mockRejectedValue(new Error("That passphrase did not match."));

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    const field = await screen.findByLabelText("Vault passphrase");
    fireEvent.change(field, { target: { value: "wrong-passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(unlockWithMethodMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("vault-use-passkey-escape")).toBeTruthy();
  });

  it("leaves the automation preference alone", async () => {
    nativePasskeyPrimary();
    trustLoadMock.mockResolvedValue({
      method: "generated_default_native_passkey_prf",
      succeeded_at: "2026-09-21T00:00:00.000Z",
    });
    const nativeTest = await import("@/lib/testing/native-test");
    const spy = vi.spyOn(nativeTest, "shouldSkipGeneratedVaultUnlockForAutomation").mockReturnValue(true);

    render(<VaultFlow user={user} onSuccess={vi.fn()} />);

    expect(await screen.findByLabelText("Vault passphrase")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(unlockGeneratedDefaultVaultMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

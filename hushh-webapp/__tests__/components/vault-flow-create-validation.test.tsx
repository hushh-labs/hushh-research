import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VaultFlow } from "@/components/vault/vault-flow";

const checkVaultMock = vi.fn();
const unlockVaultMock = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
  },
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    checkVault: (...args: unknown[]) => checkVaultMock(...args),
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

describe("VaultFlow create validation", () => {
  const user = { uid: "user-1" } as Parameters<typeof VaultFlow>[0]["user"];

  beforeEach(() => {
    vi.clearAllMocks();
    checkVaultMock.mockResolvedValue(false);
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
});

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultFlow } from "@/components/vault/vault-flow";

// --- Mocks ---
const mocks = vi.hoisted(() => ({
  checkVault: vi.fn(),
  getVaultState: vi.fn(),
  getPrimaryWrapper: vi.fn(),
  getWrapperByMethod: vi.fn(),
  unlockGeneratedDefaultVault: vi.fn(),
  unlockVault: vi.fn(),
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    checkVault: mocks.checkVault,
    getVaultState: mocks.getVaultState,
    getPrimaryWrapper: mocks.getPrimaryWrapper,
    getWrapperByMethod: mocks.getWrapperByMethod,
    unlockGeneratedDefaultVault: mocks.unlockGeneratedDefaultVault,
  },
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ unlockVault: mocks.unlockVault }),
}));

describe("VaultFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkVault.mockResolvedValue(false);

    // Default implementation for primary wrapper lookup
    mocks.getPrimaryWrapper.mockImplementation((state) =>
      state.wrappers.find((w: any) => w.method === state.primaryMethod) ?? state.wrappers[0]
    );
  });

  it("validates passphrase requirements during vault creation", async () => {
    render(<VaultFlow user={{ uid: "user-1" }} onSuccess={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /continue to vault setup/i }));

    const passphraseInput = screen.getByLabelText("Passphrase");
    const confirmInput = screen.getByLabelText("Confirm Passphrase");
    const createButton = screen.getByRole("button", { name: /create vault/i }) as HTMLButtonElement;

    fireEvent.change(passphraseInput, { target: { value: "short" } });
    expect(await screen.findByText("Minimum 8 characters required.")).toBeTruthy();
    expect(createButton.disabled).toBe(true);

    fireEvent.change(passphraseInput, { target: { value: "long-enough" } });
    fireEvent.change(confirmInput, { target: { value: "different" } });

    expect(await screen.findByText("Passphrases do not match.")).toBeTruthy();
    expect(createButton.disabled).toBe(true);
  });

  it("handles alternative unlock methods correctly", async () => {
    mocks.checkVault.mockResolvedValue(true);
    mocks.getVaultState.mockResolvedValue({
      primaryMethod: "passphrase",
      wrappers: [{ method: "passphrase" }, { method: "generated_default_web_prf" }]
    });

    render(<VaultFlow user={{ uid: "user-1" }} onSuccess={vi.fn()} />);

    expect(await screen.findByLabelText("Vault Key")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recovery Key" }));

    expect(await screen.findByLabelText("Recovery Key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeTruthy();
  });
});
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { loading: false, phoneNumber: "+919876543210", user: { uid: "owner-a", displayName: "Ankit Kumar Singh", email: "ankit@example.com", phoneNumber: null, photoURL: null } as { uid: string; displayName: string; email: string; phoneNumber: null; photoURL: null } | null },
  vault: { isVaultUnlocked: true, vaultOwnerToken: "owner-token" },
  ensure: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => mocks.vault }));
vi.mock("@/lib/services/wallet-card-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/services/wallet-card-service")>(),
  WalletCardService: { ensureCard: mocks.ensure },
}));

import { WalletProfileBootstrap } from "@/components/wallet-card/wallet-profile-bootstrap";

describe("Wallet Profile automatic provisioning", () => {
  beforeEach(() => {
    mocks.auth.loading = false;
    mocks.auth.user = { uid: "owner-a", displayName: "Ankit Kumar Singh", email: "ankit@example.com", phoneNumber: null, photoURL: null };
    mocks.vault.isVaultUnlocked = true;
    mocks.ensure.mockReset().mockResolvedValue({});
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("creates from current account basics without opening Wallet", async () => {
    const view = render(<WalletProfileBootstrap />);
    await waitFor(() => expect(mocks.ensure).toHaveBeenCalledTimes(1));
    expect(mocks.ensure).toHaveBeenCalledWith(expect.objectContaining({
      userId: "owner-a", vaultOwnerToken: "owner-token",
      payload: expect.objectContaining({ full_name: "Ankit Kumar Singh", email: "ankit@example.com", phone: "+919876543210" }),
    }));
    await act(async () => {});
    view.rerender(<WalletProfileBootstrap />);
    window.dispatchEvent(new Event("focus"));
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
  });

  it("waits for owner authority and provisions returning users after unlock", async () => {
    mocks.vault.isVaultUnlocked = false;
    const view = render(<WalletProfileBootstrap />);
    expect(mocks.ensure).not.toHaveBeenCalled();
    mocks.vault.isVaultUnlocked = true;
    view.rerender(<WalletProfileBootstrap />);
    await waitFor(() => expect(mocks.ensure).toHaveBeenCalledTimes(1));
  });

  it("cancels the previous owner's scheduled retry on account switch", async () => {
    vi.useFakeTimers();
    mocks.ensure.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
    const view = render(<WalletProfileBootstrap />);
    await act(async () => {});
    mocks.auth.user = { ...mocks.auth.user!, uid: "owner-b" };
    view.rerender(<WalletProfileBootstrap />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.ensure.mock.calls.map(([args]) => args.userId)).toEqual(["owner-a", "owner-b"]);
  });
});

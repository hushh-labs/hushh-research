import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { registerBackLayer, unwindBackLayer } from "@/lib/navigation/back-layers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  owner: "owner-a",
  getCard: vi.fn(),
  ensureCard: vi.fn(),
  readShareLink: vi.fn(),
  changed: null as (() => void) | null,
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: mocks.owner }, loading: false }) }));
vi.mock("@/hooks/use-effective-avatar-url", () => ({ useEffectiveAvatarUrl: () => null }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: true, vaultOwnerToken: `token-${mocks.owner}` }) }));
vi.mock("@/lib/navigation/use-scroll-reset", () => ({ useScrollReset: () => {} }));
vi.mock("@/components/app-ui/native-test-beacon", () => ({ NativeTestBeacon: () => null }));
vi.mock("@/components/profile/pkm-settings-shell", () => ({ PkmSettingsShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/wallet-card/wallet-card-confirm-dialog", () => ({ WalletCardConfirmDialog: () => null }));
vi.mock("@/components/wallet-card/wallet-card-manage", () => ({ WalletCardManage: ({ card, shareLink, onAction }: { card: { displayName: string }; shareLink: { shareUrl: string } | null; onAction: (action: "edit" | "preview") => void }) => <div>{card.displayName}<span>{shareLink?.shareUrl}</span><button onClick={() => onAction("edit")}>Edit profile</button><button onClick={() => onAction("preview")}>Preview profile</button></div> }));
vi.mock("@/lib/services/wallet-card-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/services/wallet-card-service")>(),
  canAddToAppleWallet: () => false,
  WalletCardService: {
    getCard: mocks.getCard,
    ensureCard: mocks.ensureCard,
    readShareLink: mocks.readShareLink,
    previewAsVisitor: async () => ({ state: "unavailable", message: "Preview unavailable" }),
    subscribe: (_owner: string, changed: () => void) => { mocks.changed = changed; return () => { mocks.changed = null; }; },
  },
}));

import { WalletCardWorkspace } from "../wallet-card-workspace";

describe("Wallet Profile owner isolation", () => {
  beforeEach(() => {
    mocks.owner = "owner-a";
    mocks.getCard.mockReset();
    mocks.ensureCard.mockReset();
    mocks.readShareLink.mockReset().mockReturnValue({ shareToken: "test-token", shareUrl: "/c/test-token" });
    mocks.changed = null;
  });
  afterEach(cleanup);

  it("closes embedded edit and preview before the containing card and cleans up on unmount", async () => {
    mocks.getCard.mockResolvedValue({ enabled: true, exists: true, card: { status: "active", displayName: "Owner profile", cardPayload: {} } });
    const view = render(<WalletCardWorkspace embedded />);
    await screen.findByRole("button", { name: "Edit profile" });
    const parent = vi.fn(() => true);
    const release = registerBackLayer({ pathname: "/one/wallet", depth: 1, back: parent });
    try {
      for (const action of ["Edit profile", "Preview profile"]) {
        fireEvent.click(screen.getByRole("button", { name: action }));
        expect(screen.queryByRole("button", { name: "Edit profile", exact: true })).toBeNull();
        act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
        expect(screen.getByRole("button", { name: "Edit profile" })).toBeVisible();
        expect(parent).not.toHaveBeenCalled();
      }
      act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
      expect(parent).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
      view.rerender(<WalletCardWorkspace embedded active={false} />);
      act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
      expect(parent).toHaveBeenCalledTimes(2);
      view.rerender(<WalletCardWorkspace embedded />);
      view.unmount();
    } finally { release(); }
    expect(unwindBackLayer("/one/wallet")).toBe(false);
  });

  it("does not show a prior owner's late automatic creation after account switch", async () => {
    let finishFirstOwner!: (value: unknown) => void;
    mocks.getCard
      .mockResolvedValueOnce({ enabled: true, exists: false, card: null })
      .mockResolvedValueOnce({ enabled: true, exists: true, card: { status: "active", displayName: "Second owner" } });
    mocks.ensureCard.mockReturnValueOnce(new Promise((resolve) => { finishFirstOwner = resolve; }));
    const view = render(<WalletCardWorkspace embedded />);
    await waitFor(() => expect(mocks.ensureCard).toHaveBeenCalledOnce());

    mocks.owner = "owner-b";
    view.rerender(<WalletCardWorkspace embedded />);
    await screen.findByText("Second owner");
    await act(async () => { finishFirstOwner({ card: { status: "active", displayName: "First owner private details" } }); });

    expect(screen.getByText("Second owner")).toBeVisible();
    expect(screen.queryByText("First owner private details")).toBeNull();
    expect(mocks.getCard).toHaveBeenLastCalledWith({ userId: "owner-b", vaultOwnerToken: "token-owner-b" });
  });

  it("recovers a remote rotation while open without looping on its own notification", async () => {
    const first = { status: "active", displayName: "Owner", shareTokenVersion: 1 };
    const rotated = { ...first, shareTokenVersion: 2 };
    let recovered = false;
    mocks.getCard.mockResolvedValueOnce({ enabled: true, exists: true, card: first }).mockResolvedValue({ card: rotated });
    mocks.readShareLink.mockImplementation((_owner, card) => card?.shareTokenVersion === 1
      ? { shareUrl: "/c/original" }
      : recovered ? { shareUrl: "/c/rotated" } : null);
    mocks.ensureCard.mockImplementation(async () => {
      recovered = true;
      mocks.changed?.();
      return { card: rotated };
    });
    render(<WalletCardWorkspace embedded />);
    await screen.findByText("/c/original");
    await act(async () => { mocks.changed?.(); });
    expect(await screen.findByText("/c/rotated")).toBeVisible();
    expect(screen.queryByText("/c/original")).toBeNull();
    expect(mocks.ensureCard).toHaveBeenCalledOnce();
    expect(mocks.getCard).toHaveBeenCalledTimes(2);
  });

  it("bounds unavailable recovery to one attempt per observed version", async () => {
    const card = { status: "active", displayName: "Owner", shareTokenVersion: 1 };
    mocks.getCard.mockResolvedValue({ enabled: true, exists: true, card });
    render(<WalletCardWorkspace embedded />);
    await screen.findByText("Owner");
    mocks.readShareLink.mockReturnValue(null);
    mocks.ensureCard.mockResolvedValue({ card });
    await act(async () => { mocks.changed?.(); });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(mocks.ensureCard).toHaveBeenCalledOnce();
    mocks.getCard.mockResolvedValue({ card: { ...card, shareTokenVersion: 2 } });
    await act(async () => { mocks.changed?.(); });
    expect(mocks.ensureCard).toHaveBeenCalledTimes(2);
  });

  it("rejects an earlier owner's delayed QR recovery after switching accounts", async () => {
    const card = { status: "active", displayName: "First owner", shareTokenVersion: 1 };
    mocks.getCard.mockResolvedValue({ enabled: true, exists: true, card });
    const view = render(<WalletCardWorkspace embedded />);
    await screen.findByText("First owner");
    // Settle the initial manage-stage refresh before simulating a new rotation.
    // Notifications during that read are intentionally coalesced by its owner.
    await act(async () => {});
    mocks.readShareLink.mockImplementation((owner) => owner === "owner-a" ? null : { shareUrl: "/c/second" });
    let finish!: (result: unknown) => void;
    mocks.ensureCard.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await act(async () => { mocks.changed?.(); });
    expect(mocks.ensureCard).toHaveBeenCalledOnce();
    mocks.owner = "owner-b";
    mocks.getCard.mockResolvedValue({ enabled: true, exists: true, card: { ...card, displayName: "Second owner" } });
    view.rerender(<WalletCardWorkspace embedded />);
    await screen.findByText("Second owner");
    await act(async () => { finish({ card }); });
    expect(screen.getByText("Second owner")).toBeVisible();
    expect(screen.queryByText("First owner")).toBeNull();
  });
});

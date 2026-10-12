import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WalletCardRecord } from "@/lib/services/wallet-card-service";
import { WalletCardManage } from "../wallet-card-manage";

const card: WalletCardRecord = {
  passSerial: "wallet-123", status: "active", shareTokenVersion: 1,
  cardPayload: {}, displayName: "Owner", headline: null, avatarUrl: null,
  expiresAt: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-08T12:00:00Z",
  revokedAt: null, lastScannedAt: "2026-10-08T13:00:00Z", scanCount: 42,
};

describe("Wallet Profile management controls", () => {
  it("keeps lifecycle actions and live QR while sharing the card image through the supplied action", () => {
    const onAction = vi.fn();
    const props = { card, shareLink: { shareUrl: "https://one.hushh.ai/c/current", shareToken: "current", version: 1 }, applePassSupported: true, busyAction: null, onAction, shareAction: <button>Share card image</button> };
    const view = render(<WalletCardManage {...props} />);
    expect(screen.getByLabelText("Your Wallet Profile QR code")).toBeVisible();
    expect(screen.getByText("42")).toBeVisible();
    expect(screen.getByRole("button", { name: "Share card image" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Share your link" })).toBeNull();

    const actions = [
      ["Preview as visitor", "preview"], ["Edit shared information", "edit"],
      ["Pause sharing", "pause"], ["Rotate QR access", "rotate"],
      ["Remove Wallet profile", "remove"], ["Add to Apple Wallet", "add-to-wallet"],
      ["Copy link", "copy"],
    ];
    for (const [label, action] of actions) {
      fireEvent.click(screen.getByRole("button", { name: (name) => name === label || name.startsWith(`${label} `) }));
      expect(onAction).toHaveBeenLastCalledWith(action);
    }
    const remove = screen.getByRole("button", { name: /^Remove Wallet profile\b/ });
    expect(remove.closest('[data-tone="destructive"]')).toBeTruthy();
    expect(remove.querySelector(".profile-pane-icon")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Preview as visitor\b/ }).querySelector(".profile-pane-icon-accent")).toBeTruthy();

    view.rerender(<WalletCardManage {...props} card={{ ...card, status: "paused" }} />);
    fireEvent.click(screen.getByRole("button", { name: /^Resume sharing\b/ }));
    expect(onAction).toHaveBeenLastCalledWith("resume");
    expect(screen.queryByRole("button", { name: /^Pause sharing\b/ })).toBeNull();
  });
});

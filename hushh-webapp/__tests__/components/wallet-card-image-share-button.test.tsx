import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WalletCardImageShareButton } from "@/components/wallet/wallet-card-image-share-button";
import { createWalletCardImageFile } from "@/lib/wallet/wallet-card-image";
import { shareFile } from "@/lib/share/share-file";

vi.mock("@/lib/wallet/wallet-card-image", () => ({ createWalletCardImageFile: vi.fn() }));
vi.mock("@/lib/share/share-file", () => ({ shareFile: vi.fn(async () => "web-share") }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ Button: ({ loading: _loading, effect: _effect, ...props }: Record<string, unknown>) => <button {...props} />, morphyToast: { success: vi.fn(), error: vi.fn() } }));

describe("card image share readiness", () => {
  it("never shares the previous owner or rotated QR while the new image is preparing", async () => {
    const first = new File(["first"], "card.png", { type: "image/png" });
    const second = new File(["second"], "card.png", { type: "image/png" });
    let resolveSecond!: (value: File) => void;
    vi.mocked(createWalletCardImageFile).mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));
    const profile = { ownerId: "first", displayName: "First Owner", shareUrl: "https://example.test/c/first" };
    const { rerender } = render(<WalletCardImageShareButton cardId="agent-one-profile" profile={profile} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Share card" })).toBeEnabled());
    rerender(<WalletCardImageShareButton cardId="agent-one-profile" profile={{ ...profile, ownerId: "second", shareUrl: "https://example.test/c/rotated" }} />);
    expect(screen.getByRole("button", { name: "Share card" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Share card" }));
    expect(shareFile).not.toHaveBeenCalled();
    await act(async () => resolveSecond(second));
    fireEvent.click(screen.getByRole("button", { name: "Share card" }));
    await waitFor(() => expect(shareFile).toHaveBeenCalledWith({ file: second, title: "Agent One Profile" }));
    rerender(<WalletCardImageShareButton cardId="agent-one-profile" profile={profile} disabled />);
    expect(screen.getByRole("button", { name: "Share card" })).toBeDisabled();
  });
});

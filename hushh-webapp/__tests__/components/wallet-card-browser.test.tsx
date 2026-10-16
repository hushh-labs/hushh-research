import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { registerBackLayer, unwindBackLayer } from "@/lib/navigation/back-layers";
import { describe, expect, it, vi } from "vitest";
import { WalletCardBrowser } from "@/components/wallet/wallet-card-browser";
import { WalletCardFace } from "@/components/wallet/wallet-card-face";
import type { WalletCardArtwork } from "@/lib/wallet/card-artwork";
import type { WalletCardSummary } from "@/lib/services/wallet-service";

vi.mock("@/components/wallet/wallet-sharing", () => ({ WalletSharing: () => <section>Card recipients</section> }));
vi.mock("@/components/wallet-card/wallet-card-workspace", () => ({ WalletCardWorkspace: ({ passVariant, active }: { passVariant: string; active: boolean }) => <section data-pass-variant={passVariant} data-active={active}>Live profile controls</section> }));
vi.mock("@/components/wallet/wallet-referral-card-details", () => ({ WalletReferralCardDetails: () => <section>Live referral controls</section> }));

function setup(cards: WalletCardSummary[] = [], selectedCardId: string | null = null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const props = { cards, selectedCardId, onSelect: vi.fn(), onOverview: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), busyCardId: null, details: <p>Protected details action</p>, dockHost: host };
  const view = render(<WalletCardBrowser {...props} />);
  return { ...view, props, dock: within(host), host };
}

describe("Wallet card browser", () => {
  it("resets scroll after the next card has committed, including a scrolled detail page", () => {
    const root = document.createElement("div");
    root.setAttribute("data-app-scroll-root", "true");
    document.body.appendChild(root);
    const committedPages: string[] = [];
    root.scrollTo = vi.fn(() => {
      committedPages.push(root.textContent || "");
      root.scrollTop = 0;
    });
    const view = render(<WalletCardBrowser cards={[]} selectedCardId={null} onSelect={() => {}} onOverview={() => {}} onAdd={() => {}} onRemove={() => {}} busyCardId={null} details={null} dockHost={null} />, { container: root });
    fireEvent.click(screen.getByRole("button", { name: "Agent One Profile" }));
    root.scrollTop = 450;
    committedPages.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Next card" }));
    expect(root.scrollTop).toBe(0);
    expect(committedPages.length).toBeGreaterThan(0);
    expect(committedPages.every(text => text.includes("Live referral controls"))).toBe(true);
    view.unmount(); root.remove();
  });
  it("unwinds the selected card before leaving Wallet and releases the handler when inactive", () => {
    const { dock, host, unmount, rerender, props } = setup();
    fireEvent.click(dock.getByRole("button", { name: "Open Agent One Profile" }));
    const childBack = vi.fn(() => true);
    const releaseChild = registerBackLayer({ pathname: "/one/wallet", depth: 2, back: childBack });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Back", exact: true }));
      expect(childBack).toHaveBeenCalledOnce();
      expect(screen.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "card");
      expect(screen.getByText("Live profile controls")).toBeVisible();
    } finally { releaseChild(); }
    act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
    expect(screen.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "all");
    expect(screen.queryByText("Live profile controls")).toBeNull();
    expect(unwindBackLayer("/one/wallet")).toBe(false);
    fireEvent.click(dock.getByRole("button", { name: "Open Agent One Profile" }));
    rerender(<WalletCardBrowser {...props} active={false} />);
    expect(unwindBackLayer("/one/wallet")).toBe(false);
    unmount(); host.remove();
  });
  it("preserves payment selection when mounted from search or after adding a card", () => {
    const card: WalletCardSummary = { cardId: "saved-card", nickname: "My card", brand: "visa", last4: "9876", expiryMonth: 5, expiryYear: 2030, issuingRegion: "IN", createdAt: "" };
    const { host, unmount } = setup([card], card.cardId);
    expect(screen.getByText("Protected details action")).toBeVisible();
    expect(screen.queryByText("Card recipients")).toBeNull();
    expect(screen.queryByText("Live profile controls")).toBeNull();
    expect(screen.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "card");
    act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
    expect(screen.queryByText("Live profile controls")).toBeNull();
    unmount(); host.remove();
  });

  it("opens actual Agent One controls without selecting payment records or showing fake banking activity", () => {
    const { props, dock, host, unmount } = setup();
    fireEvent.click(dock.getByRole("button", { name: "Open Agent One Referral" }));
    expect(screen.getByText("Live referral controls")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Card finances" })).toBeNull();
    expect(props.onSelect).toHaveBeenCalledWith("agent-one-referral");
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(screen.queryByTestId("wallet-demo-activity")).toBeNull();
    expect(screen.queryByText("Payment")).toBeNull();
    fireEvent.click(dock.getByRole("button", { name: "Open Agent One Profile" }));
    expect(screen.getByText("Live profile controls")).toBeVisible();
    fireEvent.click(dock.getByRole("button", { name: "All (3)" }));
    expect(screen.queryByText("Live profile controls")).toBeNull();
    fireEvent.click(dock.getByRole("button", { name: "Add a card" }));
    expect(props.onAdd).toHaveBeenCalledOnce();
    unmount(); host.remove();
  });

  it("keeps Agent One cards when a payment card is added and keeps payment details protected", () => {
    const card: WalletCardSummary = { cardId: "saved-card", nickname: "My card", brand: "visa", last4: "9876", expiryMonth: 5, expiryYear: 2030, issuingRegion: "IN", createdAt: "" };
    const { props, dock, host, unmount, rerender } = setup([card], card.cardId);
    expect(dock.getByRole("button", { name: "Open Agent One Profile" })).toBeInTheDocument();
    fireEvent.click(dock.getByRole("button", { name: "Open My card, ending 9876" }));
    expect(props.onSelect).toHaveBeenCalledWith("saved-card");
    expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "false");
    expect(screen.getByText("Protected details action")).toBeVisible();
    expect(screen.queryByText("Card recipients")).toBeNull();
    fireEvent.click(dock.getByRole("button", { name: "Open Agent One Profile" }));
    rerender(<WalletCardBrowser {...props} selectedCardId={null} />);
    expect(screen.getByText("Live profile controls")).toBeVisible();
    fireEvent.click(dock.getByRole("button", { name: "All (4)" }));
    expect(screen.queryByText("Protected details action")).toBeNull();
    expect(screen.queryByText("Live profile controls")).toBeNull();
    unmount(); host.remove();
  });
});


describe("Approved payment-card artwork", () => {
  const summary: WalletCardSummary = { cardId: "artwork-card", nickname: "Discover", brand: "discover", last4: "1117", expiryMonth: 12, expiryYear: 2030, issuingRegion: "US", createdAt: "" };
  const artwork: Extract<WalletCardArtwork, { source: "catalog" }> = { source: "catalog", version: 1, assetId: "owned", issuerId: "owned", productId: "owned", variantId: "one", catalogVersion: "owned-1", digest: "a".repeat(64), image: "data:image/png;base64,c3ludGhldGlj", allowOverlay: true, evidence: "owner_selected" };
  it("embeds owner details inside approved artwork and reveals the full number only when explicitly requested", () => {
    const view = render(<WalletCardFace summary={summary} artwork={artwork} cardholderName="Synthetic Owner" />);
    const face = screen.getByTestId("wallet-card-face");
    expect(within(face).getByText("Synthetic Owner")).toBeInTheDocument();
    expect(face.querySelector('[data-slot="wallet-card-number"]')).toHaveTextContent("Discover ending 1117");
    expect(face.querySelector('[data-slot="wallet-card-expiry"]')).toHaveTextContent("12/30");
    expect(face.parentElement?.querySelector(":scope > p")).toBeNull();
    expect(view.container).not.toHaveTextContent("6011111111111117");
    view.rerender(<WalletCardFace summary={summary} artwork={artwork} revealed={{ pan: "6011111111111117", cardholderName: "Synthetic Owner" }} />);
    expect(face).toHaveTextContent("Card number 6011 1111 1111 1117");
    view.rerender(<WalletCardFace summary={summary} artwork={artwork} cardholderName="Synthetic Owner" />);
    expect(face).not.toHaveTextContent("6011 1111 1111 1117");
  });
  it.each(["restricted catalog", "photo"])("does not overlay a %s image", source => {
    const restricted: WalletCardArtwork = source === "photo" ? { source: "photo", version: 1, sanitizerVersion: 1, digest: artwork.digest, image: artwork.image } : { ...artwork, allowOverlay: false };
    render(<WalletCardFace summary={summary} artwork={restricted} cardholderName="Synthetic Owner" />);
    const face = screen.getByTestId("wallet-card-face");
    expect(face.querySelector('[data-slot="wallet-card-embedded-details"]')).toBeNull();
    expect(within(face).queryByText("Synthetic Owner")).toBeNull();
    expect(screen.getByText(/Synthetic Owner ·/)).toBeInTheDocument();
  });
  it("hides unknown artwork, paints approved originals without an opacity delay, and settles image failure", () => {
    const view = render(<WalletCardFace summary={summary} artwork={artwork} artworkPending cardholderName="Synthetic Owner" />);
    const face = screen.getByTestId("wallet-card-face");
    expect(face).toHaveAttribute("data-card-artwork", "pending");
    expect(face).toHaveAttribute("aria-busy", "true");
    expect(face.querySelector("img")).toBeNull();
    expect(within(face).getByText("Synthetic Owner")).toBeInTheDocument();
    view.rerender(<WalletCardFace summary={summary} artwork={artwork} cardholderName="Synthetic Owner" />);
    const image = face.querySelector("img")!;
    expect(image).toBeVisible();
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 856 }, naturalHeight: { configurable: true, value: 540 } });
    fireEvent.load(image);
    expect(image).toBeVisible();
    expect(face).toHaveAttribute("aria-busy", "false");
    view.rerender(<WalletCardFace summary={summary} artwork={{ ...artwork, digest: "b".repeat(64), image: "data:image/png;base64,bmV4dA==" }} cardholderName="Synthetic Owner" />);
    expect(image).toBeVisible();
    expect(face).toHaveAttribute("aria-busy", "true");
    fireEvent.error(image);
    expect(face).toHaveAttribute("data-card-artwork", "neutral");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

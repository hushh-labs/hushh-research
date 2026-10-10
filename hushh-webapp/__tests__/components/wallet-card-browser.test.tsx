import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { describe, expect, it, vi } from "vitest";
import { WalletCardBrowser } from "@/components/wallet/wallet-card-browser";
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
  it("unwinds the selected card before leaving Wallet and releases the handler when inactive", () => {
    const { dock, host, unmount, rerender, props } = setup();
    fireEvent.click(dock.getByRole("button", { name: "Open Agent One Profile" }));
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
    expect(screen.getByText("Card recipients")).toBeVisible();
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
    expect(props.onSelect).not.toHaveBeenCalled();
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
    const { props, dock, host, unmount } = setup([card]);
    expect(dock.getByRole("button", { name: "Open Agent One Profile" })).toBeInTheDocument();
    fireEvent.click(dock.getByRole("button", { name: "Open My card, ending 9876" }));
    expect(props.onSelect).toHaveBeenCalledWith("saved-card");
    expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "false");
    expect(screen.getByText("Protected details action")).toBeVisible();
    expect(screen.getByText("Card recipients")).toBeVisible();
    fireEvent.click(dock.getByRole("button", { name: "All (4)" }));
    expect(screen.queryByText("Protected details action")).toBeNull();
    expect(screen.queryByText("Live profile controls")).toBeNull();
    unmount(); host.remove();
  });
});

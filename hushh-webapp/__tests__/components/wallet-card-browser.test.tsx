import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WalletCardBrowser } from "@/components/wallet/wallet-card-browser";
import type { WalletCardSummary } from "@/lib/services/wallet-service";

function setup(cards: WalletCardSummary[] = []) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const props = { cards, selectedCardId: null, onSelect: vi.fn(), onOverview: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), busyCardId: null, details: <p>Protected details action</p>, dockHost: host };
  const view = render(<WalletCardBrowser {...props} />);
  return { ...view, props, dock: within(host), host };
}

describe("Wallet card browser", () => {
  it("switches demo cards and returns to All without selecting or removing real records", () => {
    const { props, dock, host, unmount } = setup();
    fireEvent.click(dock.getByRole("button", { name: "Open Travel - Demo, ending 4444" }));
    expect(screen.getByTestId("wallet-demo-details")).toHaveTextContent("Travel card");
    expect(screen.getByTestId("wallet-demo-activity")).toHaveTextContent("₹8,640.00");
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onRemove).not.toHaveBeenCalled();
    fireEvent.click(dock.getByRole("button", { name: "All (3)" }));
    expect(screen.queryByTestId("wallet-demo-details")).toBeNull();
    expect(props.onOverview).toHaveBeenCalledOnce();
    fireEvent.click(dock.getByRole("button", { name: "Add a card" }));
    expect(props.onAdd).toHaveBeenCalledOnce();
    unmount(); host.remove();
  });

  it("keeps real cards masked, selects existing summaries, and never attaches demo statements", () => {
    const card: WalletCardSummary = { cardId: "demo-0", nickname: "My card", brand: "visa", last4: "9876", expiryMonth: 5, expiryYear: 2030, issuingRegion: "IN", createdAt: "" };
    const { props, dock, host, unmount } = setup([card]);
    fireEvent.click(dock.getByRole("button", { name: "Open My card, ending 9876" }));
    expect(props.onSelect).toHaveBeenCalledWith("demo-0");
    expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "false");
    expect(screen.queryByTestId("wallet-demo-activity")).toBeNull();
    expect(screen.queryByText("0000 0000 0000 4242")).toBeNull();
    expect(screen.getByText("Protected details action")).toBeVisible();
    fireEvent.click(dock.getByRole("button", { name: "All (1)" }));
    expect(screen.queryByText("Protected details action")).toBeNull();
    expect(props.onOverview).toHaveBeenCalledOnce();
    unmount(); host.remove();
  });
});

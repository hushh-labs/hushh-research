import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WalletAddCollection } from "@/components/wallet/wallet-add-collection";
import type { WalletCardSummary } from "@/lib/services/wallet-service";

const cards: WalletCardSummary[] = Array.from({ length: 10 }, (_, index) => ({
  cardId: `card-${index}`, nickname: `Card ${index}`, brand: "visa", last4: `100${index}`,
  expiryMonth: 4, expiryYear: 2030, issuingRegion: "IN", createdAt: "2026-01-01T00:00:00Z",
}));
const props = { selectedCardId: null, onSelect: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), busyCardId: null };

describe("Wallet Add collection", () => {
  it("offers the existing add flow without an empty stack", () => {
    render(<WalletAddCollection {...props} cards={[]} />);
    expect(screen.queryByTestId("wallet-add-stack")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add your first card" }));
    expect(props.onAdd).toHaveBeenCalled();
  });

  it("lets an empty wallet explore demo cards without saving or removing them", () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    render(<WalletAddCollection {...props} cards={[]} onSelect={onSelect} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "View all 3 cards" }));
    expect(screen.getByTestId("wallet-preview-stack")).toHaveAttribute("data-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Travel - Demo" }));
    expect(screen.getByTestId("wallet-preview-layer-demo-1")).toHaveAttribute("data-selected", "true");
    expect(screen.queryByRole("button", { name: "Remove card" })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("caps collapsed depth, exposes all cards on expansion, and preserves source order", () => {
    const original = cards.map((card) => card.cardId);
    const view = render(<WalletAddCollection {...props} cards={cards} />);
    expect(screen.getByTestId("wallet-add-layer-1004")).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "View all 10 cards" }));
    expect(screen.getByTestId("wallet-add-layer-1009")).not.toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: /Card 9, Visa ending in 1009/i }));
    expect(props.onSelect).toHaveBeenCalledWith("card-9");
    view.rerender(<WalletAddCollection {...props} cards={cards} selectedCardId="card-9" />);
    expect(screen.getByTestId("wallet-add-layer-1009")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("wallet-add-stack")).toHaveAttribute("data-expanded", "false");
    expect(cards.map((card) => card.cardId)).toEqual(original);
  });

  it("falls back when the selected card is removed and never reveals card secrets", () => {
    const view = render(<WalletAddCollection {...props} cards={cards.slice(0, 2)} selectedCardId="card-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove card" }));
    expect(props.onRemove).toHaveBeenCalledWith(cards[1]);
    view.rerender(<WalletAddCollection {...props} cards={cards.slice(0, 1)} selectedCardId="card-1" />);
    expect(screen.getByTestId("wallet-add-layer-1000")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "false");
    expect(screen.queryByRole("button", { name: /View all/ })).toBeNull();
  });

  it("accepts intentional vertical swipes but ignores short and horizontal movement", () => {
    render(<WalletAddCollection {...props} cards={cards.slice(0, 3)} />);
    const stack = screen.getByTestId("wallet-add-stack");
    const swipe = (x: number, y: number) => {
      fireEvent.touchStart(stack, { touches: [{ clientX: 100, clientY: 200 }] });
      fireEvent.touchEnd(stack, { changedTouches: [{ clientX: x, clientY: y }] });
    };
    swipe(100, 180);
    expect(stack).toHaveAttribute("data-expanded", "false");
    swipe(230, 100);
    expect(stack).toHaveAttribute("data-expanded", "false");
    swipe(100, 100);
    expect(stack).toHaveAttribute("data-expanded", "true");
    swipe(100, 300);
    expect(stack).toHaveAttribute("data-expanded", "false");
    // A swipe must not swallow the next keyboard activation (click detail=0).
    fireEvent.click(screen.getByRole("button", { name: /Card 0, Visa ending in 1000/i }), { detail: 0 });
    expect(stack).toHaveAttribute("data-expanded", "true");
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(1000);
    fireEvent.touchStart(stack, { touches: [{ clientX: 100, clientY: 200 }] });
    clock.mockReturnValue(1600);
    fireEvent.touchEnd(stack, { changedTouches: [{ clientX: 100, clientY: 350 }] });
    expect(stack).toHaveAttribute("data-expanded", "true");
    clock.mockRestore();
  });
  it("opens the active demo and updates matching details when selecting a different card", () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    const onAdd = vi.fn();
    render(<WalletAddCollection {...props} cards={[]} onSelect={onSelect} onRemove={onRemove} onAdd={onAdd} />);
    expect(screen.queryByTestId("wallet-demo-details")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Everyday - Demo" }));
    let details = within(screen.getByRole("region", { name: "Demo card details" }));
    expect(details.getByText("Everyday card")).toBeTruthy();
    expect(details.getByText("0000 0000 0000 4242")).toBeTruthy();
    expect(details.getByText("Alex Sample")).toBeTruthy();
    expect(details.getByText("12/30")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View all 3 cards" }));
    fireEvent.click(screen.getByRole("button", { name: "Travel - Demo" }));
    details = within(screen.getByRole("region", { name: "Demo card details" }));
    expect(details.getByText("Travel card")).toBeTruthy();
    expect(details.getByText("0000 0000 0000 4444")).toBeTruthy();
    expect(details.getByText("Mastercard")).toBeTruthy();
    expect(details.getByText("09/30")).toBeTruthy();
    expect(details.queryByText("Everyday card")).toBeNull();
    expect(screen.getByTestId("wallet-preview-stack")).toHaveAttribute("data-expanded", "false");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("keeps a saved card masked even when its ID matches a demo", () => {
    render(<WalletAddCollection {...props} cards={[{ ...cards[0]!, cardId: "demo-0" }]} />);
    expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "false");
    expect(document.querySelector("[data-demo-card]")).toBeNull();
    expect(document.body.textContent).not.toContain("0000 0000 0000 4242");
    expect(screen.queryByTestId("wallet-demo-details")).toBeNull();
  });

});

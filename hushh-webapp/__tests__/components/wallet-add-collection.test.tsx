import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WalletAddCollection } from "@/components/wallet/wallet-add-collection";
import { WalletCardSwipe } from "@/components/wallet/wallet-card-swipe";
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
    fireEvent.click(screen.getByRole("button", { name: "Agent One Referral" }));
    expect(screen.getByTestId("wallet-preview-layer-agent-one-referral")).toHaveAttribute("data-selected", "true");
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

  it.each(["shell", "nested"])("unfolds from native %s scrolling before the available range ends", (owner) => {
    vi.useFakeTimers();
    const renderDeck = (selectedCardId: string | null = null) => <div data-testid="scroll-owner" data-app-scroll-root={owner === "shell" ? "" : undefined} style={{ overflowY: "auto" }}>
      <WalletAddCollection {...props} cards={cards.slice(0, 3)} selectedCardId={selectedCardId} scrollReveal showDetailsLink onOpen={vi.fn()} />
    </div>;
    const view = render(renderDeck());
    const root = screen.getByTestId("scroll-owner");
    const stack = screen.getByTestId("wallet-add-stack");
    Object.defineProperties(root, { scrollHeight: { configurable: true, value: 600 }, clientHeight: { configurable: true, value: 500 } });
    Object.defineProperty(stack, "clientWidth", { configurable: true, value: 420 });
    act(() => vi.advanceTimersByTime(20));
    const last = screen.getByTestId("wallet-add-layer-1002");
    const folded = last.style.transform;
    expect(stack).toHaveAttribute("data-unfolded", "false");
    // Pointer focus and wheel events without actual movement leave the deck alone.
    fireEvent.focus(screen.getByRole("button", { name: /Card 0, Visa ending/ }));
    expect(fireEvent.wheel(stack, { deltaY: 100 })).toBe(true);
    act(() => vi.advanceTimersByTime(20));
    expect(last.style.transform).toBe(folded);
    root.scrollTop = 40;
    fireEvent.scroll(root);
    act(() => vi.advanceTimersByTime(20));
    expect(last.style.transform).not.toBe(folded);
    expect(stack).toHaveAttribute("data-unfolded", "false");
    const halfway = last.style.transform;
    view.rerender(renderDeck("card-2"));
    expect(last.style.transform).toBe(halfway);
    expect(last).toHaveAttribute("data-reveal-rank", "2");
    root.scrollTop = 80;
    fireEvent.scroll(root);
    act(() => vi.advanceTimersByTime(20));
    expect(stack).toHaveAttribute("data-unfolded", "true");
    expect(last.querySelector<HTMLElement>("[data-stack-details]")!.style.visibility).toBe("");
    // Scrolling back restores the compact deck without changing card order.
    root.scrollTop = 0;
    fireEvent.scroll(root);
    act(() => vi.advanceTimersByTime(20));
    expect(last.style.transform).toBe(folded);
    fireEvent.keyDown(screen.getByRole("button", { name: /Card 0, Visa ending/ }), { key: "Tab" });
    expect(stack).toHaveAttribute("data-unfolded", "true");
    view.unmount();
    vi.useRealTimers();
  });

  it("shows every card when a tall viewport has no native scroll range", () => {
    vi.useFakeTimers();
    const view = render(<WalletAddCollection {...props} cards={cards.slice(0, 3)} scrollReveal showDetailsLink />);
    const stack = screen.getByTestId("wallet-add-stack");
    Object.defineProperty(stack, "clientWidth", { configurable: true, value: 420 });
    act(() => vi.advanceTimersByTime(20));
    expect(stack).toHaveAttribute("data-unfolded", "true");
    expect(screen.getAllByRole("button", { name: /^View details for/ })).toHaveLength(3);
    view.unmount();
    vi.useRealTimers();
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
});


describe("Wallet card controls", () => {
  it("reveals supplied basic information, keeps details on the card, and restores keyboard focus", () => {
    const onOpen = vi.fn();
    const dismissHint = vi.fn();
    render(<WalletCardSwipe card={cards[0]} summary={{ title: "Agent One Profile", fields: [
      { label: "Username", value: "ankit.kumar.singh" },
      { label: "Member since", value: "2026" },
      { label: "Wallet ID", value: "profile-123" },
    ] }} disabled={false} onOpen={onOpen} hint dismissHint={dismissHint}>
      <button type="button" onClick={onOpen}>Agent One Profile card</button>
    </WalletCardSwipe>);
    const face = screen.getByRole("button", { name: "Agent One Profile card" });
    expect(screen.queryByRole("button", { name: "View details" })).toBeNull();
    fireEvent.keyDown(face, { key: "ArrowLeft" });
    const close = screen.getByRole("button", { name: "Back to card" });
    expect(close).toHaveFocus();
    expect(screen.getByText("ankit.kumar.singh")).toBeVisible();
    expect(screen.getByText("profile-123")).toBeVisible();
    expect(screen.queryByText("Card number")).toBeNull();
    expect(screen.queryByRole("button", { name: "View details" })).toBeNull();
    expect(dismissHint).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Back to card" })).toBeNull();
    expect(face).toHaveFocus();
    fireEvent.click(face);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("keeps masked payment information when the supplied summary only names the card", () => {
    const onOpen = vi.fn();
    render(<WalletCardSwipe card={cards[0]} summary={{ title: "My Visa" }} disabled={false} onOpen={onOpen} hint={false} dismissHint={vi.fn()}>
      <button type="button">My Visa card</button>
    </WalletCardSwipe>);
    fireEvent.keyDown(screen.getByRole("button", { name: "My Visa card" }), { key: "ArrowLeft" });
    expect(screen.getByText("•••• 1000")).toBeVisible();
    expect(screen.getByText("Visa")).toBeVisible();
    expect(screen.getByText("04/30")).toBeVisible();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to card" }));
    expect(screen.getByRole("button", { name: "My Visa card" })).toHaveFocus();
  });

  it("leaves vertical wheel scrolling alone and reveals controls only for horizontal intent", () => {
    vi.useFakeTimers();
    const view = render(<WalletCardSwipe card={cards[0]} disabled={false} onOpen={vi.fn()} hint={false} dismissHint={vi.fn()}>
      <button type="button">Saved card</button>
    </WalletCardSwipe>);
    const face = screen.getByRole("button", { name: "Saved card" });
    const swipe = face.closest("[data-controls-open]")!;
    expect(fireEvent.wheel(face, { deltaX: 10, deltaY: 100 })).toBe(true);
    act(() => vi.advanceTimersByTime(130));
    expect(swipe).toHaveAttribute("data-controls-open", "false");
    expect(fireEvent.wheel(face, { deltaX: 170, deltaY: 10 })).toBe(false);
    act(() => vi.advanceTimersByTime(130));
    expect(swipe).toHaveAttribute("data-controls-open", "true");
    view.unmount();
    vi.useRealTimers();
  });

  it("does not expose controls while the card is busy", () => {
    render(<WalletCardSwipe card={cards[0]} disabled onOpen={vi.fn()} hint={false} dismissHint={vi.fn()}>
      <button type="button">Busy card</button>
    </WalletCardSwipe>);
    const face = screen.getByRole("button", { name: "Busy card" });
    fireEvent.keyDown(face, { key: "ArrowLeft" });
    expect(screen.queryByRole("button", { name: "Back to card" })).toBeNull();
    expect(face.closest("[data-controls-open]")).toHaveAttribute("data-controls-open", "false");
  });
});

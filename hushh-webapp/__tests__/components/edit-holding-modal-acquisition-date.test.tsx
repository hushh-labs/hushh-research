import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditHoldingModal } from "@/components/kai/modals/edit-holding-modal";
import { findHoldingValidationIssue } from "@/lib/kai/holding-validation";

afterEach(async () => {
  // Radix restores focus on the next timer turn. Finish that work before the
  // test environment replaces its DOM realm for the next file.
  cleanup();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

vi.mock("@/lib/kai/ticker-universe-cache", () => ({
  getTickerUniverseSnapshot: () => [],
  preloadTickerUniverse: vi.fn().mockResolvedValue([]),
  searchTickerUniverse: () => [],
  searchTickerUniverseRemote: vi.fn().mockResolvedValue([]),
}));

describe("EditHoldingModal acquisition date (iOS-native tap contract)", () => {
  it("accepts reported cash without stock quantities and keeps the original correction entry identity", () => {
    const cash = { symbol: "CASH", name: "Sweep", quantity: 0, price: 0, market_value: 8245 };
    const invalid = { entry_id: "bad-entry", symbol: "GOOG", name: "Alphabet", quantity: 10, price: 0, market_value: 0 };
    const found = findHoldingValidationIssue([cash, { ...invalid, pending_delete: true }, invalid]);
    expect(found).toMatchObject({ index: 2, issue: { field: "price" } });
    expect(found?.holding).toBe(invalid);
    expect(findHoldingValidationIssue([cash, { ...invalid, quantity: -10, price: 100, market_value: -1000 }])).toBeNull();
  });
  it("preserves and edits a cash balance without inventing shares or a stock price", () => {
    const onSave = vi.fn();
    render(<EditHoldingModal isOpen onClose={() => {}} holding={{ symbol: "CASH", name: "Sweep", quantity: 0, price: 0, market_value: 8245 }} onSave={onSave} />);
    expect(screen.getByLabelText("Cash balance")).toHaveValue(8245);
    fireEvent.change(screen.getByLabelText("Cash balance"), { target: { value: "8000" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ quantity: 0, price: 0, market_value: 8000 }));
  });
  it("focuses the failing field and links its message when Save finds an issue", async () => {
    const onSave = vi.fn();
    render(<EditHoldingModal isOpen onClose={() => {}} holding={{ symbol: "GOOG", name: "Alphabet", quantity: 10, price: 0, market_value: 0 }} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    const price = screen.getByLabelText(/^Price/);
    await waitFor(() => expect(price).toHaveFocus());
    expect(price).toHaveAttribute("aria-invalid", "true");
    expect(price).toHaveAccessibleDescription("Enter a price above $0.");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(price, { target: { value: "1600" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ quantity: 10, price: 1600, market_value: 16000 }));
  });
  it("opens on the explicitly requested invalid field without losing the draft", async () => {
    render(<EditHoldingModal isOpen onClose={() => {}} validationIssue={{ field: "price", message: "Enter a price above $0." }} holding={{ symbol: "GOOG", name: "Alphabet", quantity: 10, price: 0, market_value: 0 }} onSave={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText(/^Price/)).toHaveFocus());
    expect(screen.getByLabelText(/^Quantity/)).toHaveValue(10);
    expect(screen.getByLabelText(/^Price/)).toHaveAccessibleDescription("Enter a price above $0.");
  });
  it("keeps an unspecified entry cost unavailable when changing shares", () => {
    const onSave = vi.fn();
    render(<EditHoldingModal isOpen onClose={() => {}} holding={{ symbol: "AAPL", name: "Apple", quantity: 1, price: 100, market_value: 100 }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ quantity: 2, market_value: 200, cost_basis: undefined, unrealized_gain_loss: undefined }));
  });
  it("keeps an explicitly zero cost basis distinct from a missing cost", () => {
    const onSave = vi.fn();
    render(<EditHoldingModal isOpen onClose={() => {}} holding={{ symbol: "AAPL", name: "Apple", quantity: 1, price: 100, market_value: 100, cost_basis: 0 }} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ cost_basis: 0, unrealized_gain_loss: 100, unrealized_gain_loss_pct: undefined }));
  });
  it("renders the date input as a full-size overlay, not a hidden 1px input", () => {
    render(
      <EditHoldingModal
        isOpen
        onClose={() => {}}
        holding={null}
        onSave={() => {}}
      />,
    );

    const dateInput = screen.getByLabelText("Acquisition date") as HTMLInputElement;
    expect(dateInput.type).toBe("date");
    // iOS WKWebView only opens the native date wheel from a direct tap ON the
    // date input. The old implementation hid it at 1px with
    // pointer-events-none and relied on programmatic showPicker()/click(),
    // which iOS ignores - the field could never be filled on device. The fix
    // is a full-size invisible overlay that receives the real tap.
    expect(dateInput.className).toContain("absolute inset-0");
    expect(dateInput.className).toContain("h-full w-full");
    expect(dateInput.className).not.toContain("pointer-events-none");
    expect(dateInput.getAttribute("aria-hidden")).toBeNull();
    expect(dateInput.tabIndex).not.toBe(-1);
  });

  it("updates the visible display when a date is chosen", () => {
    render(
      <EditHoldingModal
        isOpen
        onClose={() => {}}
        holding={null}
        onSave={() => {}}
      />,
    );

    const dateInput = screen.getByLabelText("Acquisition date") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2024-03-15" } });
    expect(dateInput.value).toBe("2024-03-15");
    expect(screen.getByText("03/15/2024")).toBeTruthy();
  });

  it("rejects future acquisition dates on save", () => {
    const onSave = vi.fn();
    render(
      <EditHoldingModal
        isOpen
        onClose={() => {}}
        holding={{
          symbol: "AAPL",
          name: "Apple",
          quantity: 1,
          price: 100,
          market_value: 100,
        }}
        onSave={onSave}
      />,
    );

    const dateInput = screen.getByLabelText("Acquisition date") as HTMLInputElement;
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    const futureIso = `${nextYear.getFullYear()}-01-01`;
    fireEvent.change(dateInput, { target: { value: futureIso } });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Acquisition date cannot be in the future")).toBeTruthy();
  });
});

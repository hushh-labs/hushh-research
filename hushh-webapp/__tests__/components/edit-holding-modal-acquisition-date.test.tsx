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

describe("EditHoldingModal acquisition date", () => {
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
  it("saves the selected day without losing broker-reported gain or market value", async () => {
    const onSave = vi.fn();
    render(<EditHoldingModal isOpen onClose={() => {}} holding={{
      symbol: "AAPL", name: "Apple", quantity: 1, price: 100, market_value: 98, acquisition_date: "02/01/2024",
      unrealized_gain_loss: -2, unrealized_gain_loss_pct: -2,
    }} onSave={onSave} />);

    const trigger = screen.getByRole("button", { name: "Choose acquisition date from calendar" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    const calendar = screen.getByRole("group", { name: "Acquisition date calendar" });
    expect(calendar).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("combobox", { name: "Acquisition month" })).toHaveTextContent("February");
    fireEvent.click(screen.getByRole("button", { name: "Thursday, February 29, 2024" }));

    expect(screen.queryByRole("group", { name: "Acquisition date calendar" })).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByLabelText("Acquisition date")).toHaveValue("29/02/2024");
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ acquisition_date: "2024-02-29",
      market_value: 98, unrealized_gain_loss: -2, unrealized_gain_loss_pct: -2 }));

    fireEvent.change(screen.getByLabelText("Cost Basis (Total)"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ market_value: 98, cost_basis: 80,
      unrealized_gain_loss: 18, unrealized_gain_loss_pct: 22.5 }));
  });

  it("rejects impossible typed dates and persists a corrected date in ISO format", () => {
    const onSave = vi.fn();
    render(<EditHoldingModal isOpen onClose={() => {}} holding={{ symbol: "AAPL", name: "Apple", quantity: 1, price: 100, market_value: 100 }} onSave={onSave} />);
    const date = screen.getByLabelText("Acquisition date");
    const save = screen.getByRole("button", { name: /save/i });
    fireEvent.change(date, { target: { value: "30022024" } });
    fireEvent.click(save);
    expect(date).toHaveAttribute("aria-invalid", "true");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(date, { target: { value: "2902202412" } });
    expect(date).toHaveValue("29/02/2024");
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ acquisition_date: "2024-02-29" }));
    fireEvent.change(date, { target: { value: "" } });
    fireEvent.click(save);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ acquisition_date: undefined }));
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

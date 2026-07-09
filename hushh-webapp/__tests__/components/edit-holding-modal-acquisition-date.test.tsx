import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EditHoldingModal } from "@/components/kai/modals/edit-holding-modal";

vi.mock("@/lib/kai/ticker-universe-cache", () => ({
  getTickerUniverseSnapshot: () => [],
  preloadTickerUniverse: vi.fn().mockResolvedValue([]),
  searchTickerUniverse: () => [],
  searchTickerUniverseRemote: vi.fn().mockResolvedValue([]),
}));

describe("EditHoldingModal acquisition date (iOS-native tap contract)", () => {
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

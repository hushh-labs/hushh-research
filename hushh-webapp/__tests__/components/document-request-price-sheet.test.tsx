import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DocumentRequestPriceSheet,
  type DocumentRequestPriceSheetProps,
} from "@/components/consent/document-request-price-sheet";

/**
 * The owner's price for a request from outside the Trusted circle. The server
 * enforces the same whole-dollar $1 to $500 rule; this sheet must never offer
 * to send anything else, and a free request must never carry a price at all.
 */

function renderSheet(overrides: Partial<DocumentRequestPriceSheetProps> = {}) {
  const props: DocumentRequestPriceSheetProps = {
    open: true,
    requesterLabel: "Kushal Trivedi",
    paymentRequired: true,
    busy: false,
    error: null,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  const view = render(<DocumentRequestPriceSheet {...props} />);
  return { ...view, props };
}

function priceChips() {
  return within(screen.getByRole("group", { name: "Price" })).getAllByRole(
    "button",
  );
}

describe("DocumentRequestPriceSheet", () => {
  it("offers the preset prices, starting at $10, and submits the chosen one", () => {
    const { props } = renderSheet();

    expect(screen.getByRole("dialog", { name: "Allow request" })).toBeTruthy();
    // Payment comes after the search finds files, and before anything is shared.
    expect(
      screen.getByText(
        "Kushal Trivedi pays this once matching files are found. Nothing is shared before payment.",
      ),
    ).toBeTruthy();
    expect(priceChips().map((chip) => chip.textContent)).toEqual([
      "$10",
      "$20",
      "$30",
      "Custom",
    ]);
    expect(screen.getByRole("button", { name: "$10" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "$20" }));

    expect(screen.getByRole("button", { name: "$20" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "$10" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow · $20" }));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(2000);
  });

  it("accepts a whole-dollar custom price and refuses anything else", () => {
    const { props } = renderSheet();

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    const input = screen.getByLabelText("Custom price");
    expect(input).toHaveAttribute("inputmode", "numeric");

    fireEvent.change(input, { target: { value: "20" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow · $20" }));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(2000);

    // Cents, zero and above the $500 ceiling never become a submittable price.
    for (const value of ["20.5", "0", "600"]) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Choose a whole-dollar price from $1 to $500.",
      );
      expect(input).toHaveAttribute("aria-invalid", "true");
      const allow = screen.getByRole("button", { name: "Allow" });
      expect(allow).toBeDisabled();
      fireEvent.click(allow);
      fireEvent.keyDown(input, { key: "Enter" });
    }
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("shows what Allow grants, and holds Allow until those terms have loaded", () => {
    const { props, rerender } = renderSheet({ detailsPending: true });

    expect(screen.getByRole("status")).toHaveTextContent("Loading request…");
    const pending = screen.getByRole("button", { name: "Allow · $10" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(props.onSubmit).not.toHaveBeenCalled();

    rerender(
      <DocumentRequestPriceSheet
        {...props}
        detailsPending={false}
        purpose="Tax returns and bank statements"
        recipientEmail="kushal@example.invalid"
        periodStart="2015-01-01"
        periodEnd="2026-10-09"
      />,
    );
    expect(screen.getByText("“Tax returns and bank statements”")).toBeTruthy();
    expect(screen.getByText("kushal@example.invalid")).toBeTruthy();
    expect(screen.getByText("2015-01-01 – 2026-10-09")).toBeTruthy();
    expect(screen.getByText("Viewer, until removed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow · $10" }));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(1000);
  });

  it("shows no price for a free request and submits null", () => {
    const { props } = renderSheet({ paymentRequired: false });

    expect(screen.queryByRole("group", { name: "Price" })).toBeNull();
    expect(screen.queryByLabelText("Custom price")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("cancels without submitting, and holds still while a decision is in flight", () => {
    const { props, rerender } = renderSheet();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();

    rerender(
      <DocumentRequestPriceSheet {...props} busy error="This request changed." />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Allow · $10" })).toBeDisabled();
    for (const chip of priceChips()) expect(chip).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("This request changed.");
  });

  it("opens each time at the default price, not the last request's price", () => {
    const { props, rerender } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Custom price"), {
      target: { value: "45" },
    });
    expect(screen.getByRole("button", { name: "Allow · $45" })).toBeTruthy();

    rerender(<DocumentRequestPriceSheet {...props} open={false} />);
    rerender(<DocumentRequestPriceSheet {...props} open />);

    expect(screen.getByRole("button", { name: "$10" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByLabelText("Custom price")).toBeNull();
    expect(screen.getByRole("button", { name: "Allow · $10" })).toBeTruthy();
  });
});

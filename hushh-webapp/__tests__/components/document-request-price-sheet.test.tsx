import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DocumentRequestPriceSheet,
  ONE_COPY_ALLOW_DISCLOSURE,
  type DocumentRequestPriceSheetProps,
} from "@/components/consent/document-request-price-sheet";

vi.mock("@/components/consent/document-payout-account", () => ({
  DocumentPayoutAccountCard: () => <span>Drive account setup</span>,
}));

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
  it("edits a Drive model estimate in cents and enforces decimal boundaries", () => {
    const { props } = renderSheet({ moneyPolicy: "drive_cents", initialAmountCents: 1050 });
    const input = screen.getByLabelText("Custom price");
    expect(input).toHaveValue("10.5");
    expect(input).toHaveAttribute("inputmode", "decimal");
    for (const [value, cents, label] of [["0.50", 50, "$0.50"], ["20.51", 2051, "$20.51"], ["500", 50000, "$500"]] as const) {
      fireEvent.change(input, { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: `Allow · ${label}` }));
      expect(props.onSubmit).toHaveBeenLastCalledWith(cents);
    }
    for (const value of ["0.49", "500.01", "20.001", "1e2", "-1", "0"]) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("$0.50 to $500");
    }
    expect(props.onSubmit).toHaveBeenCalledTimes(3);
  });

  it("sets a trusted request price without an Allow label", () => {
    const { props } = renderSheet({ priceOnly: true });
    expect(screen.getByRole("dialog", { name: "Set price" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save · $10" }));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(1000);
    expect(screen.queryByRole("button", { name: /Allow/ })).toBeNull();
  });

  it("uses the Feed type scale shared by every dialog in this flow", () => {
    renderSheet({ priceOnly: true });
    const dialog = screen.getByRole("dialog", { name: "Set price" });
    // Header: the 15px title and 11px line of the Feed's shared-files list.
    expect(dialog).toHaveClass(
      "[--type-navigation-title-size:15px]",
      "[--foundation-title3-size:15px]",
      "[--type-row-description-size:11px]",
    );
    // Body: settings rows are sized from CSS variables in the base layer,
    // which outranks any utility class, so the scale must set the variables.
    const body = Array.from(dialog.querySelectorAll("div")).find((element) =>
      element.classList.contains("[--type-row-label-size:13px]"));
    expect(body).toBeDefined();
    expect(body).toHaveClass("max-[360px]:[--type-row-label-size:12.5px]");
  });

  it("prefills an asynchronously loaded draft and keeps it editable", () => {
    const { props, rerender } = renderSheet({
      priceOnly: true,
      detailsPending: true,
    });
    rerender(
      <DocumentRequestPriceSheet
        {...props}
        detailsPending={false}
        initialAmountCents={1200}
      />,
    );
    expect(screen.getByLabelText("Custom price")).toHaveValue("12");
    expect(screen.getByRole("button", { name: "Save · $12" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    fireEvent.click(screen.getByRole("button", { name: "Save · $20" }));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(2000);
  });

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

  it("shows the estimate the requester saw and still lets the owner choose the price", () => {
    // The estimate is never a fixed price; the old locked prop no longer locks.
    const { props } = renderSheet({
      estimateCents: 1000,
      initialAmountCents: 1000,
      lockedAmountCents: 1000,
    });
    expect(screen.getByText("Requester saw an estimate of $10")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/fixed|lock/i);
    fireEvent.click(screen.getByRole("button", { name: "$30" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow · $30" }));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(3000);
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

  // Allow also accepts a requested One copy, so its terms show before Allow is
  // possible. Set price grants no copy and never shows them.
  it("shows the One copy terms with an Allow that accepts them, never beside Set price", () => {
    const { props, rerender } = renderSheet({ oneCopyRequested: true, detailsPending: true });
    expect(screen.queryByText(ONE_COPY_ALLOW_DISCLOSURE)).toBeNull();
    rerender(<DocumentRequestPriceSheet {...props} detailsPending={false} />);
    expect(screen.getByText(ONE_COPY_ALLOW_DISCLOSURE)).toBeVisible();
    expect(screen.getByRole("button", { name: "Allow · $10" })).toBeEnabled();
    rerender(<DocumentRequestPriceSheet {...props} detailsPending={false} priceOnly />);
    expect(screen.queryByText(ONE_COPY_ALLOW_DISCLOSURE)).toBeNull();
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
      <DocumentRequestPriceSheet
        {...props}
        busy
        error="This request changed."
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Allow · $10" })).toBeDisabled();
    for (const chip of priceChips()) expect(chip).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This request changed.",
    );
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

it("answer settlement reuses pricing without invoking Drive account setup", () => {
  renderSheet({ settlement: <span>Answer account setup</span> });
  expect(screen.getByText("Answer account setup")).toBeVisible();
  expect(screen.queryByText("Drive account setup")).toBeNull();
  expect(screen.queryByText(/Undelivered files/)).toBeNull();
});

it("lets a non-file lane replace the Drive delivery sentence", () => {
  // Request scope prices one written answer. This sheet told that owner their
  // files were about to be found and shared, which is the Drive lane's
  // promise and not the one they are approving.
  renderSheet({
    settlement: <span>Answer account setup</span>,
    description: "They pay this price before the answer is written.",
    deliveryDescription: "One written answer",
  });
  expect(
    screen.getByText("They pay this price before the answer is written."),
  ).toBeVisible();
  expect(screen.queryByText(/matching files/)).toBeNull();
  expect(screen.getByText("One written answer")).toBeVisible();
  expect(screen.queryByText("Viewer, until removed")).toBeNull();
});

it("keeps the Drive sentence when no lane description is supplied", () => {
  // Negative control: the document workflow's own wording is unchanged.
  renderSheet();
  expect(screen.getByText(/matching files are found/)).toBeVisible();
  expect(screen.getByText("Viewer, until removed")).toBeVisible();
});

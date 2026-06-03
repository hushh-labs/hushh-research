import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import { CurrencyInput } from "@/components/app-ui/currency-input";

/**
 * Accessible currency input tests.
 *
 * Mirrors the established `credit-card-input` test pattern in this repo:
 * exercises formatting, the onChange contract, the a11y attributes that
 * matter for assistive technology, and keyboard behavior.
 */

function getInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector("input");
  if (!input) throw new Error("input not found");
  return input as HTMLInputElement;
}

describe("CurrencyInput — display formatting", () => {
  it("renders empty by default with the default placeholder", () => {
    const { container } = render(<CurrencyInput aria-label="Amount" />);
    const input = getInput(container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("0.00");
  });

  it("formats a controlled numeric value into the locale-grouped display", () => {
    const { container } = render(
      <CurrencyInput value={1234567.89} aria-label="Amount" />
    );
    const input = getInput(container);
    expect(input.value).toBe("1,234,567.89");
  });

  it("groups thousands as the user types", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <CurrencyInput onChange={handleChange} aria-label="Amount" />
    );
    const input = getInput(container);

    fireEvent.change(input, { target: { value: "1234567" } });
    expect(input.value).toBe("1,234,567");
  });

  it("normalizes to fixed decimal places on blur", () => {
    const { container } = render(
      <CurrencyInput decimals={2} aria-label="Amount" />
    );
    const input = getInput(container);

    fireEvent.change(input, { target: { value: "42.5" } });
    fireEvent.blur(input);
    expect(input.value).toBe("42.50");
  });

  it("strips letters and currency glyphs from user input", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <CurrencyInput onChange={handleChange} aria-label="Amount" />
    );
    const input = getInput(container);

    fireEvent.change(input, { target: { value: "$1,2a3b4c" } });
    expect(input.value).toBe("1,234");
  });

  it("keeps only the first decimal point when the user types extras", () => {
    const { container } = render(<CurrencyInput aria-label="Amount" />);
    const input = getInput(container);

    fireEvent.change(input, { target: { value: "12.3.4.5" } });
    expect(input.value).toBe("12.345");
  });
});

describe("CurrencyInput — onChange contract", () => {
  it("emits a canonical number, not a formatted string", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <CurrencyInput onChange={handleChange} aria-label="Amount" />
    );
    const input = getInput(container);

    fireEvent.change(input, { target: { value: "1,234.56" } });
    expect(handleChange).toHaveBeenLastCalledWith(1234.56);
  });

  it("emits null when the field is cleared", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <CurrencyInput value={42} onChange={handleChange} aria-label="Amount" />
    );
    const input = getInput(container);

    fireEvent.change(input, { target: { value: "" } });
    expect(handleChange).toHaveBeenLastCalledWith(null);
  });

  it("preserves a leading minus sign", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <CurrencyInput onChange={handleChange} aria-label="Amount" />
    );
    const input = getInput(container);

    fireEvent.change(input, { target: { value: "-100" } });
    expect(handleChange).toHaveBeenLastCalledWith(-100);
  });
});

describe("CurrencyInput — accessibility", () => {
  it("sets inputMode='decimal' for mobile numeric keypads", () => {
    const { container } = render(<CurrencyInput aria-label="Amount" />);
    expect(getInput(container).getAttribute("inputmode")).toBe("decimal");
  });

  it("renders the currency symbol visually but hides it from per-keystroke announcements", () => {
    const { container, getByText } = render(
      <CurrencyInput currencySymbol="€" aria-label="Amount" />
    );
    // Visual prefix
    const visual = getByText("€");
    expect(visual.getAttribute("aria-hidden")).toBe("true");
    // Screen-reader-only descriptor announced once via aria-describedby
    const describedById = getInput(container).getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const srSpan = container.querySelector(`#${describedById?.split(" ")[0]}`);
    expect(srSpan?.textContent).toMatch(/€ amount/);
  });

  it("sets aria-invalid when value exceeds max", () => {
    const { container } = render(
      <CurrencyInput value={9999} max={1000} aria-label="Amount" />
    );
    expect(getInput(container).getAttribute("aria-invalid")).toBe("true");
  });

  it("sets aria-invalid when value is below min", () => {
    const { container } = render(
      <CurrencyInput value={-5} min={0} aria-label="Amount" />
    );
    expect(getInput(container).getAttribute("aria-invalid")).toBe("true");
  });

  it("forces aria-invalid when an errorMessage is provided", () => {
    const { container } = render(
      <CurrencyInput
        value={50}
        errorMessage="Enter at least $100"
        aria-label="Amount"
      />
    );
    expect(getInput(container).getAttribute("aria-invalid")).toBe("true");
  });

  it("exposes errorMessage to assistive tech via an alert role", () => {
    const { getByRole } = render(
      <CurrencyInput
        value={50}
        errorMessage="Enter at least $100"
        aria-label="Amount"
      />
    );
    const alert = getByRole("alert");
    expect(alert.textContent).toBe("Enter at least $100");
  });

  it("associates with a parent <label> via the provided id", () => {
    const { container } = render(
      <>
        <label htmlFor="deposit-amount">Deposit amount</label>
        <CurrencyInput id="deposit-amount" />
      </>
    );
    const input = getInput(container);
    expect(input.id).toBe("deposit-amount");
    const label = container.querySelector('label[for="deposit-amount"]');
    expect(label).toBeTruthy();
  });
});

describe("CurrencyInput — keyboard behavior", () => {
  it("ArrowUp increments by 1", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <CurrencyInput value={10} onChange={handleChange} aria-label="Amount" />
    );
    fireEvent.keyDown(getInput(container), { key: "ArrowUp" });
    expect(handleChange).toHaveBeenLastCalledWith(11);
  });

  it("ArrowDown decrements by 1", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <CurrencyInput value={10} onChange={handleChange} aria-label="Amount" />
    );
    fireEvent.keyDown(getInput(container), { key: "ArrowDown" });
    expect(handleChange).toHaveBeenLastCalledWith(9);
  });

  it("Shift+ArrowUp increments by 10", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <CurrencyInput value={10} onChange={handleChange} aria-label="Amount" />
    );
    fireEvent.keyDown(getInput(container), { key: "ArrowUp", shiftKey: true });
    expect(handleChange).toHaveBeenLastCalledWith(20);
  });

  it("clamps to max when arrow stepping would exceed it", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <CurrencyInput
        value={99}
        max={100}
        onChange={handleChange}
        aria-label="Amount"
      />
    );
    fireEvent.keyDown(getInput(container), { key: "ArrowUp", shiftKey: true });
    expect(handleChange).toHaveBeenLastCalledWith(100);
  });

  it("clamps to min when arrow stepping would go below it", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <CurrencyInput
        value={1}
        min={0}
        onChange={handleChange}
        aria-label="Amount"
      />
    );
    fireEvent.keyDown(getInput(container), { key: "ArrowDown", shiftKey: true });
    expect(handleChange).toHaveBeenLastCalledWith(0);
  });
});

describe("CurrencyInput — disabled & ref forwarding", () => {
  it("disables the input and dims the wrapper", () => {
    const { container } = render(
      <CurrencyInput disabled value={100} aria-label="Amount" />
    );
    expect(getInput(container).disabled).toBe(true);
  });

  it("forwards the ref to the underlying <input>", () => {
    const ref = { current: null as HTMLInputElement | null };
    render(<CurrencyInput ref={ref} aria-label="Amount" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });
});
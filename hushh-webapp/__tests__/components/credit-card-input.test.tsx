import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CreditCardInput } from "@/components/app-ui/credit-card-input";

describe("CreditCardInput Component - Formatting & Detection", () => {
  it("formats standard 16-digit cards with 4-4-4-4 spacing", () => {
    const { getByRole } = render(<CreditCardInput />);
    const input = getByRole("textbox") as HTMLInputElement;

    // Simulate typing a Visa card
    fireEvent.change(input, { target: { value: "4111222233334444" } });
    
    expect(input.value).toBe("4111 2222 3333 4444");
  });

  it("formats American Express cards with 4-6-5 spacing", () => {
    const { getByRole } = render(<CreditCardInput />);
    const input = getByRole("textbox") as HTMLInputElement;

    // Simulate typing an Amex card
    fireEvent.change(input, { target: { value: "341234567890123" } });
    
    expect(input.value).toBe("3412 345678 90123");
  });

  it("strips non-numeric characters automatically", () => {
    const { getByRole } = render(<CreditCardInput />);
    const input = getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "4111abcd2222" } });
    
    expect(input.value).toBe("4111 2222");
  });

  it("passes the raw, unformatted number back via onValueChange", () => {
    const onValueChangeMock = vi.fn();
    const { getByRole } = render(<CreditCardInput onValueChange={onValueChangeMock} />);
    const input = getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "4111 2222" } });
    
    // The parent form should receive "41112222", not "4111 2222"
    expect(onValueChangeMock).toHaveBeenCalledWith("41112222");
  });

  it("updates an aria-live region when a card brand is detected", () => {
    const { getByRole, container } = render(<CreditCardInput />);
    const input = getByRole("textbox");
    const liveRegion = container.querySelector('[aria-live="polite"]');

    fireEvent.change(input, { target: { value: "51" } }); // Mastercard prefix
    
    expect(liveRegion?.textContent).toBe("Mastercard card detected");
  });
});
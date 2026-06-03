import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

// Stub the Firebase module that the modal transitively imports via ApiService;
// no Firebase network or auth calls run in unit tests.
vi.mock("@/lib/firebase/config", () => ({
  app: {},
  auth: {},
  getRecaptchaVerifier: vi.fn(),
  prepareRecaptchaVerifier: vi.fn(),
  resetRecaptcha: vi.fn(),
}));

// Replace the Vaul-based Drawer with simple passthroughs so the modal
// renders its children inline in jsdom (Vaul defers content rendering
// behind animation flags that never fire in a headless test environment).
// Using `children` returns directly — valid React component output — keeps
// the factory free of React/JSX references that vi.mock hoisting can lose.
import type { ReactNode } from "react";
vi.mock("@/components/ui/drawer", () => ({
  Drawer: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? children : null,
  DrawerClose: ({ children }: { children?: ReactNode }) => children,
  DrawerContent: ({ children }: { children?: ReactNode }) => children,
  DrawerDescription: ({ children }: { children?: ReactNode }) => children,
  DrawerFooter: ({ children }: { children?: ReactNode }) => children,
  DrawerHeader: ({ children }: { children?: ReactNode }) => children,
  DrawerTitle: ({ children }: { children?: ReactNode }) => children,
}));

import { EditHoldingModal } from "@/components/kai/modals/edit-holding-modal";

/**
 * Caller proof for `CurrencyInput`.
 *
 * This test does NOT exercise the standalone component in isolation
 * (that's covered by `__tests__/components/currency-input.test.tsx`).
 * Instead it asserts the *integration* into a concrete money form —
 * the existing portfolio holding editor — proving the component is
 * reachable from a real consumer and producing the expected runtime
 * value flow (formatted display, canonical numeric output).
 *
 * Per maintainer guidance on PR #987: ship attach proof, not just
 * compile-and-test parity for a detached helper.
 */

const baseHolding = {
  id: "h-1",
  symbol: "AAPL",
  name: "Apple Inc.",
  quantity: 10,
  price: 150,
  market_value: 1500,
  cost_basis: 1200,
  acquisition_date: null,
};

function renderModal(overrides: Partial<typeof baseHolding> = {}, onSave = vi.fn()) {
  return render(
    <EditHoldingModal
      isOpen={true}
      onClose={vi.fn()}
      onSave={onSave}
      holding={{ ...baseHolding, ...overrides }}
    />
  );
}

// The Drawer mock renders inline, so the inputs live in the document.
function priceInput(): HTMLInputElement {
  const node = document.querySelector<HTMLInputElement>("#edit-holding-price");
  if (!node) throw new Error("price CurrencyInput not found");
  return node;
}

function costBasisInput(): HTMLInputElement {
  const node = document.querySelector<HTMLInputElement>("#edit-holding-cost-basis");
  if (!node) throw new Error("cost-basis CurrencyInput not found");
  return node;
}

function findLabelFor(id: string): HTMLLabelElement | null {
  return document.querySelector<HTMLLabelElement>(`label[for="${id}"]`);
}

function clickSaveButton(): void {
  const buttons = Array.from(document.querySelectorAll("button"));
  const save = buttons.find((b) => /save/i.test(b.textContent ?? ""));
  if (!save) throw new Error("Save button not found");
  save.click();
}

describe("EditHoldingModal — CurrencyInput integration", () => {
  it("renders the existing holding's price as locale-formatted currency", () => {
    renderModal({ price: 1234.5 });
    expect(priceInput().value).toBe("1,234.50");
  });

  it("renders the existing holding's cost basis as locale-formatted currency", () => {
    renderModal({ cost_basis: 12345.6 });
    expect(costBasisInput().value).toBe("12,345.60");
  });

  it("groups thousands as the user types into Price", () => {
    renderModal();
    const input = priceInput();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1234567" } });
    expect(input.value).toBe("1,234,567");
  });

  it("normalizes Price to 2 decimal places on blur", () => {
    renderModal();
    const input = priceInput();

    fireEvent.change(input, { target: { value: "42.5" } });
    fireEvent.blur(input);
    expect(input.value).toBe("42.50");
  });

  it("strips non-numeric characters from Price input", () => {
    renderModal();
    const input = priceInput();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "$1,2a3b4c" } });
    expect(input.value).toBe("1,234");
  });

  it("exposes inputMode='decimal' so mobile users get the numeric keypad", () => {
    renderModal();
    expect(priceInput().getAttribute("inputmode")).toBe("decimal");
    expect(costBasisInput().getAttribute("inputmode")).toBe("decimal");
  });

  it("associates each input with its <label> via htmlFor/id for screen readers", () => {
    renderModal();
    expect(findLabelFor("edit-holding-price")).toBeTruthy();
    expect(findLabelFor("edit-holding-cost-basis")).toBeTruthy();
  });

  it("flows the canonical numeric value back into the form state via onChange", () => {
    const onSave = vi.fn();
    renderModal({}, onSave);

    fireEvent.change(priceInput(), { target: { value: "199.99" } });
    fireEvent.change(costBasisInput(), { target: { value: "1500" } });

    clickSaveButton();

    expect(onSave).toHaveBeenCalledTimes(1);
    const submitted = onSave.mock.calls[0]![0] as {
      price: number;
      cost_basis: number;
    };
    expect(submitted.price).toBe(199.99);
    expect(submitted.cost_basis).toBe(1500);
  });
});
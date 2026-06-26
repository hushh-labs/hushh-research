import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@base-ui/react", () => ({
  Combobox: {
    Root: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    Value: ({
      children,
      "data-slot": dataSlot,
    }: {
      children?: React.ReactNode;
      "data-slot"?: string;
    }) => <span data-slot={dataSlot}>{children}</span>,
  },
}));

import { Combobox, ComboboxValue } from "@/components/ui/combobox";

describe("ComboboxValue", () => {
  it("renders with data-slot='combobox-value'", () => {
    const { container } = render(
      <Combobox>
        <ComboboxValue />
      </Combobox>,
    );

    const element = container.querySelector(
      '[data-slot="combobox-value"]',
    );

    expect(element?.getAttribute("data-slot")).toBe("combobox-value");
  });
});
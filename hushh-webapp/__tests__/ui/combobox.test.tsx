import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxTrigger,
} from "@/components/ui/combobox";

describe("ComboboxChip", () => {
  it("renders chip remove with the combobox-chip-remove data-slot contract", () => {
    const { container } = render(
      <Combobox items={["Profile"]} multiple>
        <ComboboxChips>
          <ComboboxChip>Profile</ComboboxChip>
        </ComboboxChips>
      </Combobox>,
    );

    expect(
      container.querySelector('[data-slot="combobox-chip-remove"]'),
    ).toBeTruthy();
  });
});

describe("ComboboxTrigger", () => {
  it("propagates custom class names", () => {
    const { container } = render(
      <Combobox>
        <ComboboxTrigger className="custom-combobox-trigger" />
      </Combobox>,
    );
    expect(container.querySelector('[data-slot="combobox-trigger"]')?.className).toContain("custom-combobox-trigger");
  });
});

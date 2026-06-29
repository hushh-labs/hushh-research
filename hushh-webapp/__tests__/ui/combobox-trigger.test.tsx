import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Combobox, ComboboxTrigger } from "@/components/ui/combobox";

describe("ComboboxTrigger", () => {
  it("exposes the combobox trigger data-slot contract", () => {
    const { container } = render(
      <Combobox>
        <ComboboxTrigger>Choose option</ComboboxTrigger>
      </Combobox>,
    );

    expect(
      container.querySelector('[data-slot="combobox-trigger"]'),
    ).not.toBeNull();
  });
});
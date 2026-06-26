import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Select,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

describe("Select", () => {
  it("renders trigger with data-slot='select-trigger'", () => {
    const { container } = render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>,
    );

    expect(
      container.querySelector('[data-slot="select-trigger"]'),
    ).toBeTruthy();
  });

  it("defaults trigger to data-size='default'", () => {
    const { container } = render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>,
    );

    const trigger = container.querySelector('[data-slot="select-trigger"]');

    expect(trigger?.getAttribute("data-size")).toBe("default");
  });

  it("propagates size='sm' as data-size='sm'", () => {
    const { container } = render(
      <Select>
        <SelectTrigger size="sm">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>,
    );

    const trigger = container.querySelector('[data-slot="select-trigger"]');

    expect(trigger?.getAttribute("data-size")).toBe("sm");
  });
});
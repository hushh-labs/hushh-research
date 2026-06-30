import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Select,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

describe("SelectTrigger", () => {
  it("renders as a button element", () => {
    const { container } = render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>,
    );

    const trigger = container.querySelector(
      '[data-slot="select-trigger"]',
    );

    expect(trigger?.tagName).toBe("BUTTON");
  });
});
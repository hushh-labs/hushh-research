import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CommandPickerField } from "@/components/app-ui/command-fields";

describe("CommandPickerField", () => {
  it("renders clear selection control as a button", () => {
    render(
      <CommandPickerField
        title="Pick a tier"
        value="ace"
        placeholder="Select tier"
        allowClear
        onSelect={vi.fn()}
        options={[
          {
            value: "ace",
            label: "Ace",
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "Clear selection" }).getAttribute("type")).toBe(
      "button",
    );
  });
});

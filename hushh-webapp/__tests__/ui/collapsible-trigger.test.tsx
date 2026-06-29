import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Collapsible,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

describe("CollapsibleTrigger", () => {
  it("renders as a button element", () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>
          Toggle
        </CollapsibleTrigger>
      </Collapsible>,
    );

    const trigger = screen.getByRole(
      "button",
      { name: "Toggle" },
    );

    expect(trigger.tagName).toBe("BUTTON");
  });
});
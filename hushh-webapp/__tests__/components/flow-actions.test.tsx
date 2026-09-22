import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  FlowActionGroup,
  FlowSelectionSummary,
} from "@/components/app-ui/flow-actions";

describe("FlowActionGroup", () => {
  it("keeps the secondary action before the primary in DOM and responsive layout", () => {
    const { container } = render(
      <FlowActionGroup
        secondary={<button type="button">Cancel</button>}
        primary={<button type="button">Continue</button>}
      />,
    );

    const actions = screen.getAllByRole("button");
    expect(actions.map((action) => action.textContent)).toEqual([
      "Cancel",
      "Continue",
    ]);

    const group = container.querySelector('[data-ui-role="flow-actions"]');
    expect(group?.firstElementChild?.className).toContain("grid");
    expect(group?.firstElementChild?.className).toContain("sm:flex");
    expect(
      group?.querySelector('[data-action-priority="secondary"]'),
    ).toBeTruthy();
    expect(
      group?.querySelector('[data-action-priority="primary"]'),
    ).toBeTruthy();
  });

  it("caps decision actions and publishes the selected values", () => {
    const { container } = render(
      <>
        <FlowSelectionSummary
          label="Sharing with"
          value="3 people"
          detail="For 1 hour"
        />
        <FlowActionGroup
          measure="decision"
          primary={<button type="button">Start sharing</button>}
        />
      </>,
    );

    expect(screen.getByText("Sharing with")).toBeTruthy();
    expect(screen.getByText("3 people")).toBeTruthy();
    expect(screen.getByText("For 1 hour")).toBeTruthy();
    expect(
      container.querySelector('[data-ui-role="flow-actions"]')?.className,
    ).toContain("max-w-[30rem]");
  });
});

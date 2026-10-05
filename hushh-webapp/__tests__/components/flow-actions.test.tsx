import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  FlowActionGroup,
  FlowSelectionSummary,
} from "@/components/app-ui/flow-actions";

describe("FlowActionGroup", () => {
  it("shows the primary before the separated secondary action on phones", () => {
    const { container } = render(
      <FlowActionGroup
        secondary={<button type="button">Cancel</button>}
        primary={<button type="button">Continue</button>}
      />,
    );

    const actions = screen.getAllByRole("button");
    expect(actions.map((action) => action.textContent)).toEqual([
      "Continue",
      "Cancel",
    ]);

    const group = container.querySelector('[data-ui-role="flow-actions"]');
    expect(group?.firstElementChild?.className).toContain("grid");
    expect(group?.firstElementChild?.className).toContain("sm:flex");
    const primary = group?.querySelector('[data-action-priority="primary"]');
    const secondary = group?.querySelector(
      '[data-action-priority="secondary"]',
    );
    expect(primary).toBeTruthy();
    expect(secondary).toBeTruthy();
    expect(primary?.className).toContain("order-1");
    expect(secondary?.className).toContain("order-2");
    expect(secondary?.className).toContain("border-t");
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

  it("can keep stacked secondary actions grouped without a divider", () => {
    const { container } = render(
      <FlowActionGroup
        stacked
        separateSecondary={false}
        secondary={<button type="button">Cancel</button>}
        primary={<button type="button">Create code</button>}
      />,
    );

    const secondary = container.querySelector(
      '[data-action-priority="secondary"]',
    );
    expect(secondary).toBeTruthy();
    expect(secondary?.className).not.toContain("border-t");
    expect(secondary?.className).not.toContain("pt-2");
  });
});

import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { EmptyState } from "@/components/app-ui/empty-state";

describe("EmptyState Component - Layout & A11y", () => {
  it("renders the title and description correctly", () => {
    const { getByText } = render(
      <EmptyState title="No items found" description="Try adjusting your filters." />
    );
    expect(getByText("No items found")).toBeDefined();
    expect(getByText("Try adjusting your filters.")).toBeDefined();
  });

  it("includes mandatory accessibility roles for dynamic announcements", () => {
    const { container } = render(
      <EmptyState title="Empty" description="Nothing here" />
    );
    const section = container.querySelector("section");
    expect(section?.getAttribute("role")).toBe("status");
    expect(section?.getAttribute("aria-live")).toBe("polite");
  });

  it("hides the decorative icon from screen readers to prevent noise", () => {
    const { container } = render(
      <EmptyState
        icon={<svg data-testid="test-icon" />}
        title="Empty"
        description="Nothing here"
      />
    );
    const iconWrapper = container.querySelector("div[aria-hidden='true']");
    expect(iconWrapper).toBeDefined();
    expect(iconWrapper?.querySelector("svg")).toBeDefined();
  });
});
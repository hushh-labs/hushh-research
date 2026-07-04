import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectionChip } from "@/components/agent/selection-chip";

describe("SelectionChip", () => {
  it("renders the label", () => {
    render(<SelectionChip label="Abdul Zalil · 8 hours" />);
    expect(screen.getByText("Abdul Zalil · 8 hours")).toBeTruthy();
  });

  it("uses primary tokens, not cream", () => {
    const { container } = render(<SelectionChip label="Mom" />);
    expect(container.innerHTML).not.toContain("#b8894d");
    expect(container.innerHTML).not.toContain("#d4a574");
  });
});

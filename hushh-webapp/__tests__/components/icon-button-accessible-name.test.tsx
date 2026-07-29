import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function IconButton() {
  return (
    <button
      type="button"
      aria-label="Optimize portfolio"
      title="Optimize portfolio"
    >
      ⚡
    </button>
  );
}

describe("icon button accessible name", () => {
  it("preserves accessible name contract for icon-only buttons", () => {
    render(<IconButton />);

    const button = screen.getByRole("button", {
      name: "Optimize portfolio",
    });

    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-label")).toBe(
      "Optimize portfolio",
    );
  });
});
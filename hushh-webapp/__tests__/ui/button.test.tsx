import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders a disabled button", () => {
    const { container } = render(<Button disabled>Save</Button>);

    const button = container.querySelector("button");

    expect(button).not.toBeNull();
    expect(button?.hasAttribute("disabled")).toBe(true);
  });
  it("merges a custom className onto the button element", () => {
  const { container } = render(
    <Button className="test-class">
      Save
    </Button>,
  );

  const button =container.querySelector("button");

  expect(
    button?.classList.contains(
      "test-class",
    ),
  ).toBe(true);
});
});
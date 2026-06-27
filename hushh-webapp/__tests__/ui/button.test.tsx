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

  it("defaults to type='button' to prevent accidental form submission", () => {
    const { container } = render(<Button>Save</Button>);

    const button = container.querySelector("button");

    expect(button?.getAttribute("type")).toBe("button");
  });

});
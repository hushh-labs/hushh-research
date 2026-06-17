import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "@/lib/morphy-ux/button";

describe("Button", () => {
  it("sets aria-busy during loading state", () => {
    render(<Button loading>Save changes</Button>);

    const button = screen.getByRole("button", { name: /save changes/i });

    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});

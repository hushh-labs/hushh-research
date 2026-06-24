import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Switch } from "@/components/ui/switch";

describe("Switch", () => {
  it("respects default checked state", () => {
    render(<Switch defaultChecked />);

    expect(screen.getByRole("switch").getAttribute("data-state")).toBe(
      "checked",
    );
  });
});
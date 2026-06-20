import { render } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sonnerProps: [] as Array<{ icons?: Record<string, React.ReactNode> }>,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light" }),
}));

vi.mock("sonner", () => ({
  Toaster: (props: { icons?: Record<string, React.ReactNode> }) => {
    mocks.sonnerProps.push(props);
    return null;
  },
}));

import { Toaster } from "@/components/ui/sonner";

describe("Toaster", () => {
  it("hides decorative status icons from assistive technology", () => {
    render(<Toaster />);

    const icons = mocks.sonnerProps.at(-1)?.icons;

    expect(icons).toBeTruthy();
    for (const status of ["success", "info", "warning", "error", "loading"]) {
      const icon = icons?.[status];

      expect(React.isValidElement(icon)).toBe(true);
      expect(
        React.isValidElement(icon) ? icon.props["aria-hidden"] : undefined,
      ).toBe("true");
    }
  });
});

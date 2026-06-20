import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Toaster } from "@/components/ui/sonner";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system" }),
}));

vi.mock("sonner", () => ({
  Toaster: ({ visibleToasts }: { visibleToasts?: number }) => (
    <div data-testid="sonner-toaster" data-visible-toasts={visibleToasts} />
  ),
}));

describe("Toaster", () => {
  it("uses the default visible toast count", () => {
    render(<Toaster />);

    expect(screen.getByTestId("sonner-toaster").getAttribute("data-visible-toasts")).toBe(
      "2",
    );
  });
});

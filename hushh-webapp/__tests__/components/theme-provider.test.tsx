import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { ThemeProvider } from "@/components/theme-provider";

describe("ThemeProvider", () => {
  it("renders children", () => {
    render(
      <ThemeProvider attribute="class" defaultTheme="system">
        <span>child content</span>
      </ThemeProvider>
    );
    expect(screen.getByText("child content")).toBeDefined();
  });
});

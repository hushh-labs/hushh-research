import { render, screen } from "@testing-library/react";
import { Cpu } from "lucide-react";
import { describe, expect, it } from "vitest";

import { ThemeFocusList } from "@/components/kai/cards/theme-focus-list";

describe("ThemeFocusList", () => {
  it("renders empty themes fallback", () => {
    render(<ThemeFocusList themes={[]} />);

    expect(
      screen.getByText("No active market themes are available right now."),
    ).toBeTruthy();
  });

  it("renders list of themes with fallback icons if not provided", () => {
    const mockThemes = [
      {
        title: "Artificial Intelligence",
        subtitle: "Companies leading AI research and hardware",
      },
      {
        title: "Renewable Energy",
        subtitle: "Solar, wind, and storage technology providers",
      },
    ] as any[];

    render(<ThemeFocusList themes={mockThemes} />);

    expect(screen.getByText("Artificial Intelligence")).toBeTruthy();
    expect(screen.getByText("Companies leading AI research and hardware")).toBeTruthy();
    expect(screen.getByText("Renewable Energy")).toBeTruthy();
    expect(screen.getByText("Solar, wind, and storage technology providers")).toBeTruthy();
  });

  it("renders list of themes with specified icons", () => {
    const mockThemes = [
      {
        id: "theme-1",
        title: "High Performance Computing",
        subtitle: "Advanced processing units and accelerators",
        icon: Cpu,
      },
    ];

    render(<ThemeFocusList themes={mockThemes} />);

    expect(screen.getByText("High Performance Computing")).toBeTruthy();
    expect(screen.getByText("Advanced processing units and accelerators")).toBeTruthy();
  });
});

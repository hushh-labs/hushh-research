import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const themeState = {
  theme: "light" as string | undefined,
  resolvedTheme: "dark" as string | undefined,
  setTheme: vi.fn(),
};

vi.mock("next-themes", () => ({
  useTheme: () => themeState,
}));

import { ThemeToggleLean } from "@/components/theme-toggle";
import { nextThemePreference } from "@/lib/theme/theme-preference";

describe("ThemeToggleLean", () => {
  beforeEach(() => {
    window.localStorage.clear();
    themeState.theme = "light";
    themeState.resolvedTheme = "dark";
    themeState.setTheme.mockReset();
  });

  it("uses the persisted preference instead of a transient context default", async () => {
    window.localStorage.setItem("theme", "dark");
    render(<ThemeToggleLean />);

    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("updates the selected segment optimistically before the provider rerenders", async () => {
    window.localStorage.setItem("theme", "dark");
    render(<ThemeToggleLean />);

    await screen.findByRole("radio", { name: "Dark", checked: true });
    fireEvent.click(screen.getByRole("radio", { name: "System" }));

    expect(themeState.setTheme).toHaveBeenCalledWith("system");
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("cycles System, Light, and Dark without losing the System preference", () => {
    expect(nextThemePreference("system")).toBe("light");
    expect(nextThemePreference("light")).toBe("dark");
    expect(nextThemePreference("dark")).toBe("system");
    expect(nextThemePreference(undefined)).toBe("light");
  });
});

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

  it("uses the shared radio keyboard contract without repeating an unchanged preference", async () => {
    render(<ThemeToggleLean size="compact" />);
    const light = await screen.findByRole("radio", { name: "Light", checked: true });
    expect(screen.getAllByRole("radio").filter(node => node.tabIndex === 0)).toHaveLength(1);
    fireEvent.click(light);
    expect(themeState.setTheme).not.toHaveBeenCalled();
    fireEvent.keyDown(light, { key: "End" });
    const system = screen.getByRole("radio", { name: "System", checked: true });
    expect(system).toHaveFocus();
    expect(themeState.setTheme).toHaveBeenCalledExactlyOnceWith("system");
    fireEvent.keyDown(system, { key: "ArrowLeft", metaKey: true });
    expect(themeState.setTheme).toHaveBeenCalledTimes(1);
  });
});

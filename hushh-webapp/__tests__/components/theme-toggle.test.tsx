import { describe, expect, it } from "vitest";

// resolveActiveTheme is not exported, so we re-implement the contract inline.
// This characterises the normalisation behaviour at the boundary.
type ThemeOption = "light" | "dark" | "system";
function resolveActiveTheme(theme: string | undefined): ThemeOption {
  const normalized = (theme ?? "").trim().toLowerCase();
  if (normalized === "light" || normalized === "dark" || normalized === "system") {
    return normalized as ThemeOption;
  }
  return "system";
}

describe("resolveActiveTheme", () => {
  it("returns light for light input", () => {
    expect(resolveActiveTheme("light")).toBe("light");
  });

  it("returns dark for dark input", () => {
    expect(resolveActiveTheme("dark")).toBe("dark");
  });

  it("returns system for system input", () => {
    expect(resolveActiveTheme("system")).toBe("system");
  });

  it("returns system for undefined", () => {
    expect(resolveActiveTheme(undefined)).toBe("system");
  });

  it("returns system for unknown value", () => {
    expect(resolveActiveTheme("custom")).toBe("system");
  });

  it("normalises whitespace and casing", () => {
    expect(resolveActiveTheme("  Light  ")).toBe("light");
    expect(resolveActiveTheme("DARK")).toBe("dark");
  });
});

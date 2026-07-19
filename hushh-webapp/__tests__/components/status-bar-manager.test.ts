import { describe, expect, it } from "vitest";
import { SystemBarsStyle } from "@capacitor/core";

import { resolveNativeSystemBarStyle } from "@/components/status-bar-manager";

describe("StatusBarManager contrast policy", () => {
  it("uses the ambient top surface before the global theme fallback", () => {
    expect(resolveNativeSystemBarStyle("dark", "light")).toBe(
      SystemBarsStyle.Dark,
    );
    expect(resolveNativeSystemBarStyle("light", "dark")).toBe(
      SystemBarsStyle.Light,
    );
  });

  it("keeps the theme fallback when no ambient surface has been sampled", () => {
    expect(resolveNativeSystemBarStyle(null, "dark")).toBe(
      SystemBarsStyle.Dark,
    );
    expect(resolveNativeSystemBarStyle(null, "light")).toBe(
      SystemBarsStyle.Light,
    );
  });
});

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", theme: "light" }),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  SystemBars: {},
  SystemBarsStyle: { Dark: "dark", Light: "light" },
  SystemBarType: { StatusBar: "status", NavigationBar: "navigation" },
}));

import { StatusBarManager } from "@/components/status-bar-manager";

describe("StatusBarManager", () => {
  it("renders nothing into the DOM", () => {
    const { container } = render(<StatusBarManager />);
    expect(container.firstChild).toBeNull();
  });
});

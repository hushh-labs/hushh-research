import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DashboardRouteTabs } from "@/components/kai/layout/dashboard-route-tabs";

vi.mock("next/navigation", () => ({
  usePathname: () => "/kai/dashboard",
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

vi.mock("@/lib/navigation/kai-bottom-chrome-visibility", () => ({
  useKaiBottomChromeVisibility: () => ({
    hidden: false,
    progress: 0,
  }),
}));

vi.mock("@/lib/stores/kai-session-store", () => ({
  useKaiSession: (
    selector: (state: { busyOperations: Record<string, boolean> }) => unknown,
  ) => selector({ busyOperations: {} }),
}));

describe("DashboardRouteTabs", () => {
  it("covers active tab current state", async () => {
    render(<DashboardRouteTabs embedded />);

    const activeTab = await screen.findByRole("tab", {
      name: "Portfolio",
    });

    expect(activeTab.getAttribute("aria-selected")).toBe("true");
    expect(activeTab.getAttribute("aria-current")).toBe("page");
  });
});

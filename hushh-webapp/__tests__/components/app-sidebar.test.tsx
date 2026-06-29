import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppSidebar } from "@/components/dashboard/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/kai",
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/lib/consent/use-consent-pending-summary-count", () => ({
  useConsentPendingSummaryCount: () => 0,
}));

describe("AppSidebar", () => {
  it("covers decorative sidebar icons hidden", () => {
    const { container } = render(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>,
    );

    expect(screen.getAllByRole("link", { name: "Kai" })).toHaveLength(2);
    expect(screen.getByRole("link", { name: /consents/i })).toBeTruthy();

    const hiddenIcons = Array.from(
      container.querySelectorAll("svg[aria-hidden='true']"),
    );

    expect(hiddenIcons).toHaveLength(3);
    expect(
      hiddenIcons.every(
        (icon) => icon.getAttribute("aria-hidden") === "true",
      ),
    ).toBe(true);
  });
});

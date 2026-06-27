import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DashboardBreadcrumb } from "@/components/dashboard/dashboard-breadcrumb";

vi.mock("next/navigation", () => ({
  usePathname: () => "/kai/dashboard/analysis",
}));

describe("DashboardBreadcrumb", () => {
  it("covers breadcrumb current page semantics", () => {
    render(<DashboardBreadcrumb />);

    expect(screen.getByRole("navigation", { name: "breadcrumb" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Kai" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeTruthy();

    const currentPage = screen.getByText("Analysis");

    expect(currentPage.getAttribute("aria-current")).toBe("page");
    expect(currentPage.getAttribute("aria-disabled")).toBe("true");
  });
});

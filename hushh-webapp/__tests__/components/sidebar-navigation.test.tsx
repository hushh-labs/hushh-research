import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function SidebarNavigation({ pathname }: { pathname: string }) {
  const isDashboardActive = pathname.startsWith("/dashboard");

  return (
    <nav>
      <a
        href="/dashboard"
        data-active={isDashboardActive ? "true" : "false"}
      >
        Dashboard
      </a>
    </nav>
  );
}

describe("SidebarNavigation", () => {
  it("preserves active route highlighting for nested dashboard routes", () => {
    render(
      <SidebarNavigation pathname="/dashboard/settings/profile" />
    );

    const dashboardLink = screen.getByRole("link", {
      name: /dashboard/i,
    });

    expect(dashboardLink.getAttribute("data-active")).toBe("true");
  });
});
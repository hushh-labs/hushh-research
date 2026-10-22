/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RiaPrimaryWorkspaceShell } from "@/components/ria/ria-page-shell";

const navigation = vi.hoisted(() => ({ pathname: "/ria/profile" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({ title }: { title: ReactNode }) => (
    <header data-testid="ria-identity-header">{title}</header>
  ),
  SectionHeader: () => <div />,
}));

vi.mock("@/components/ria/layout/ria-route-selector", () => ({
  RiaRouteSelector: () => <nav data-testid="ria-route-selector" />,
}));

describe("RiaPrimaryWorkspaceShell", () => {
  beforeEach(() => {
    navigation.pathname = "/ria/profile";
  });

  it("keeps the compact agent shell and identity header mounted while the route content changes", () => {
    const { rerender } = render(
      <RiaPrimaryWorkspaceShell>
        <div>Profile content</div>
      </RiaPrimaryWorkspaceShell>,
    );
    const header = screen.getByTestId("ria-identity-header");
    const shell = screen.getByRole("main");
    expect(shell).toHaveAttribute("data-app-shell-width", "agent");
    expect(shell).toHaveAttribute("data-app-header-content-spacing", "compact");

    navigation.pathname = "/ria/clients";
    rerender(
      <RiaPrimaryWorkspaceShell>
        <div>Clients content</div>
      </RiaPrimaryWorkspaceShell>,
    );

    expect(screen.getByTestId("ria-identity-header")).toBe(header);
    expect(screen.getByRole("main")).toBe(shell);
    expect(screen.getByTestId("ria-route-selector")).toBeInTheDocument();
    expect(screen.getByText("Clients content")).toBeInTheDocument();
  });
});

/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeWorkspaceRoute } from "@/lib/capacitor/native-workspace-surface";
import { RiaPrimaryWorkspaceShell } from "@/components/ria/ria-page-shell";

const navigation = vi.hoisted(() => ({ pathname: "/ria/profile", push: vi.fn(), replace: vi.fn() }));
const advisor = vi.hoisted(() => ({
  experimental: false, loading: false, refreshing: false, riaCapability: "setup",
  riaOnboardingStatus: null as { advisory_status: string } | null,
  project: vi.fn<(props: ComponentProps<typeof NativeWorkspaceRoute>) => void>(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: "advisor-owner" }) }));
vi.mock("@/lib/persona/persona-context", () => ({ usePersonaState: () => advisor }));
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({
  customNativePresentationEnabled: () => advisor.experimental,
}));
vi.mock("@/lib/capacitor/native-workspace-surface", () => ({
  NativeWorkspaceRoute: (props: ComponentProps<typeof NativeWorkspaceRoute>) => {
    advisor.project(props);
    return props.children;
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation,
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({ title }: { title: ReactNode }) => (
    <header data-testid="ria-identity-header">{title}</header>
  ),
  SectionHeader: () => <div />,
}));

vi.mock("@/components/ria/layout/ria-route-selector", () => ({
  useRiaRouteTabs: () => ({ activeValue: "clients", tabs: [{ value: "profile", label: "Profile" }, { value: "clients", label: "Clients" }] }),
  RiaRouteSelector: () => <nav data-testid="ria-route-selector" />,
}));

describe("RiaPrimaryWorkspaceShell", () => {
  beforeEach(() => {
    navigation.pathname = "/ria/profile";
    advisor.experimental = false;
    advisor.loading = advisor.refreshing = false;
    advisor.riaCapability = "setup";
    advisor.riaOnboardingStatus = null;
    vi.clearAllMocks();
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
  it("keeps the setup notice read-only and offers verification only after persona resolution", () => {
    advisor.experimental = true;
    navigation.pathname = "/ria/clients";
    const page = () => <RiaPrimaryWorkspaceShell><div>Existing roster</div></RiaPrimaryWorkspaceShell>;
    const view = render(page());
    const current = () => advisor.project.mock.lastCall![0];
    expect(current().active).toBe(true);
    expect(current().sections[0].rows.some(row => row.run)).toBe(false);
    expect(current().tabs?.options.filter(tab => tab.selected).map(tab => tab.key)).toEqual(["clients"]);
    advisor.riaCapability = "enabled";
    advisor.refreshing = true;
    view.rerender(page());
    expect(current().active).toBe(false);
    advisor.refreshing = false;
    view.rerender(page());
    const verify = current().sections[0].rows.find(row => row.label === "Complete verification");
    expect(current().active).toBe(true);
    verify?.run?.();
    expect(navigation.push).toHaveBeenCalledWith("/ria/onboarding");
    advisor.riaOnboardingStatus = { advisory_status: "verified" };
    view.rerender(page());
    expect(current().active).toBe(false);
    expect(screen.getByText("Existing roster")).toBeInTheDocument();
  });
});

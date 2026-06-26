import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Navbar } from "@/components/navbar";
import { ROUTES } from "@/lib/navigation/routes";

const navigationMock = vi.hoisted(() => ({
  pathname: "/connected-systems",
  push: vi.fn(),
}));

const personaMock = vi.hoisted(() => ({
  activePersona: "investor" as string | null,
}));

const agentPopoverMock = vi.hoisted(() => ({
  expanded: false,
  openAgent: vi.fn(),
}));

const kaiSessionMock = vi.hoisted(() => {
  const setLastKaiPath = vi.fn();
  const setLastRiaPath = vi.fn();
  const state = {
    busyOperations: {},
    setLastKaiPath,
    setLastRiaPath,
  };
  const useKaiSession = Object.assign(
    vi.fn((selector?: (value: typeof state) => unknown) =>
      typeof selector === "function" ? selector(state) : state,
    ),
    {
      getState: vi.fn(() => state),
    },
  );
  return { useKaiSession, setLastKaiPath, setLastRiaPath };
});

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({
    push: navigationMock.push,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
  }),
}));

vi.mock("@/components/agent/agent-popover-provider", () => ({
  useOptionalAgentPopover: () => ({
    expanded: agentPopoverMock.expanded,
    openAgent: agentPopoverMock.openAgent,
  }),
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({
    activePersona: personaMock.activePersona,
  }),
}));

vi.mock("@/lib/consent/use-consent-pending-summary-count", () => ({
  useConsentPendingSummaryCount: () => 0,
}));

vi.mock("@/lib/navigation/kai-bottom-chrome-visibility", () => ({
  useKaiBottomChromeVisibility: () => ({
    hidden: false,
    progress: 0,
  }),
}));

vi.mock("@/lib/stores/kai-session-store", () => ({
  useKaiSession: kaiSessionMock.useKaiSession,
}));

describe("Navbar bottom navigation", () => {
  beforeEach(() => {
    navigationMock.pathname = ROUTES.CONNECTED_SYSTEMS;
    navigationMock.push.mockReset();
    personaMock.activePersona = "investor";
    kaiSessionMock.setLastKaiPath.mockReset();
    kaiSessionMock.setLastRiaPath.mockReset();
    agentPopoverMock.expanded = false;
    agentPopoverMock.openAgent.mockReset();
  });

  it("keeps the fixed One/Connect/Profile set on One subroutes without injecting a subroute tab", () => {
    // On a One subroute (connected systems) the bottom nav stays the fixed
    // top-level set. The subroute does not surface its own tab (finance-style).
    render(<Navbar />);

    expect(screen.getByRole("radio", { name: "One" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Connect" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Profile" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Systems" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Consent" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Search" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
  });

  it("shows the root One/Connect/Profile switch without empty pill slots on the One dashboard", () => {
    navigationMock.pathname = ROUTES.ONE_HOME;

    render(<Navbar />);

    const routeNav = screen.getByRole("radiogroup", {
      name: "Route navigation",
    });
    expect(screen.getByRole("radio", { name: "One" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Connect" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Profile" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Gmail" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Consent" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Market" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Search" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
    expect(routeNav.getAttribute("style")).toContain(
      "grid-template-columns: repeat(3, minmax(0, 1fr))",
    );
    expect(
      within(routeNav)
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["One", "Connect", "Profile"]);

    fireEvent.click(screen.getByRole("radio", { name: "Connect" }));
    expect(navigationMock.push).toHaveBeenLastCalledWith(ROUTES.MARKETPLACE);

    fireEvent.click(screen.getByRole("radio", { name: "Profile" }));
    expect(navigationMock.push).toHaveBeenLastCalledWith(ROUTES.PROFILE);
  });

  it("shows the same root switch on Profile without adding route-family tabs", () => {
    navigationMock.pathname = ROUTES.PROFILE;

    render(<Navbar />);

    expect(screen.getByRole("radio", { name: "One" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Connect" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Profile" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Gmail" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Market" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Search" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
  });

  it("shows One, Connect, and Profile with Connect active on the marketplace route", () => {
    navigationMock.pathname = ROUTES.MARKETPLACE;
    personaMock.activePersona = "ria";

    render(<Navbar />);

    const routeNav = screen.getByRole("radiogroup", {
      name: "Route navigation",
    });
    expect(
      within(routeNav)
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["One", "Connect", "Profile"]);
    expect(
      screen
        .getByRole("radio", { name: "Connect" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("radio", { name: "RIA" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Market" })).toBeNull();
  });

  it("uses five-slot finance context inside Investor routes", () => {
    navigationMock.pathname = ROUTES.KAI_ANALYSIS;

    render(<Navbar />);

    expect(screen.getByRole("radio", { name: "Market" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Portfolio" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Connect" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Analysis" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Profile" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "One" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "RIA" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
    expect(
      within(
        screen.getByRole("radiogroup", { name: "Route navigation" }),
      )
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["Market", "Portfolio", "Analysis", "Connect", "Profile"]);
  });

  it("uses five-slot advisory context inside RIA routes", () => {
    navigationMock.pathname = ROUTES.RIA_PICKS;
    personaMock.activePersona = "ria";

    render(<Navbar />);

    expect(screen.getByRole("radio", { name: "RIA" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Clients" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Connect" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Picks" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Profile" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "One" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Market" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
    expect(
      within(
        screen.getByRole("radiogroup", { name: "Route navigation" }),
      )
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["RIA", "Clients", "Picks", "Connect", "Profile"]);
  });
});

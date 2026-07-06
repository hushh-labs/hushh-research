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
  const setAgentNavigationContext = vi.fn(
    (context: { scope: "one" | "investor" | "ria"; sectionId?: string | null }) => {
      state.lastAgentNavScope = context.scope;
      state.lastAgentSectionId = context.sectionId ?? null;
    },
  );
  const state = {
    busyOperations: {},
    lastAgentNavScope: "one" as "one" | "investor" | "ria" | null,
    lastAgentSectionId: null as string | null,
    setLastKaiPath,
    setLastRiaPath,
    setAgentNavigationContext,
  };
  const useKaiSession = Object.assign(
    vi.fn((selector?: (value: typeof state) => unknown) =>
      typeof selector === "function" ? selector(state) : state,
    ),
    {
      getState: vi.fn(() => state),
    },
  );
  return { useKaiSession, setLastKaiPath, setLastRiaPath, setAgentNavigationContext, state };
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
    kaiSessionMock.state.lastAgentNavScope = "one";
    kaiSessionMock.state.lastAgentSectionId = null;
    kaiSessionMock.setLastKaiPath.mockReset();
    kaiSessionMock.setLastRiaPath.mockReset();
    kaiSessionMock.setAgentNavigationContext.mockClear();
    agentPopoverMock.expanded = false;
    agentPopoverMock.openAgent.mockReset();
  });

  it("uses the active One agent app as the first bottom tab on One subroutes", () => {
    render(<Navbar />);

    expect(screen.getByRole("radio", { name: "Systems" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Connect" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Profile" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Consent" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "One" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Search" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
  });

  it("uses Gmail as the app tab on the Gmail agent route", () => {
    navigationMock.pathname = ROUTES.GMAIL;

    render(<Navbar />);

    expect(
      within(screen.getByRole("radiogroup", { name: "Route navigation" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["Gmail", "Connect", "Profile"]);
    expect(
      screen
        .getByRole("radio", { name: "Gmail" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("radio", { name: "One" })).toBeNull();
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

  it("keeps the last One agent app on Profile when the user came from Gmail", () => {
    navigationMock.pathname = ROUTES.PROFILE;
    kaiSessionMock.state.lastAgentNavScope = "one";
    kaiSessionMock.state.lastAgentSectionId = "gmail";

    render(<Navbar />);

    expect(
      within(screen.getByRole("radiogroup", { name: "Route navigation" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["Gmail", "Connect", "Profile"]);
    expect(
      screen
        .getByRole("radio", { name: "Profile" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps the finance tab set on Profile when the user came from Finance", () => {
    navigationMock.pathname = ROUTES.PROFILE;
    kaiSessionMock.state.lastAgentNavScope = "investor";

    render(<Navbar />);

    expect(
      within(screen.getByRole("radiogroup", { name: "Route navigation" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["Market", "Portfolio", "Analysis", "Connect", "Profile"]);
    expect(
      screen
        .getByRole("radio", { name: "Profile" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("radio", { name: "One" })).toBeNull();
  });

  it("keeps the finance tab set with Connect active on Marketplace after Finance", () => {
    navigationMock.pathname = ROUTES.MARKETPLACE;
    kaiSessionMock.state.lastAgentNavScope = "investor";

    render(<Navbar />);

    expect(
      within(screen.getByRole("radiogroup", { name: "Route navigation" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["Market", "Portfolio", "Analysis", "Connect", "Profile"]);
    expect(
      screen
        .getByRole("radio", { name: "Connect" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("radio", { name: "One" })).toBeNull();
  });

  it("keeps the RIA tab set on Profile when the user came from RIA", () => {
    navigationMock.pathname = ROUTES.PROFILE;
    personaMock.activePersona = "ria";
    kaiSessionMock.state.lastAgentNavScope = "ria";

    render(<Navbar />);

    expect(
      within(screen.getByRole("radiogroup", { name: "Route navigation" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["RIA", "Clients", "Picks", "Connect", "Profile"]);
    expect(
      screen
        .getByRole("radio", { name: "Profile" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("radio", { name: "One" })).toBeNull();
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

  it("keeps the last One agent app on Connect when the user came from Gmail", () => {
    navigationMock.pathname = ROUTES.MARKETPLACE;
    kaiSessionMock.state.lastAgentNavScope = "one";
    kaiSessionMock.state.lastAgentSectionId = "gmail";

    render(<Navbar />);

    expect(
      within(screen.getByRole("radiogroup", { name: "Route navigation" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["Gmail", "Connect", "Profile"]);
    expect(
      screen
        .getByRole("radio", { name: "Connect" })
        .getAttribute("aria-checked"),
    ).toBe("true");
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

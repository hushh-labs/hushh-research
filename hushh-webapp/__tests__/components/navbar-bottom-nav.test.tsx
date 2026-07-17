import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Navbar } from "@/components/navbar";
import { ROUTES } from "@/lib/navigation/routes";

const navigationMock = vi.hoisted(() => ({
  pathname: "/one",
  push: vi.fn(),
}));

const agentPopoverMock = vi.hoisted(() => ({ expanded: false }));

const kaiSessionMock = vi.hoisted(() => {
  const state = {
    busyOperations: {},
    setLastKaiPath: vi.fn(),
    setLastRiaPath: vi.fn(),
    setAgentNavigationContext: vi.fn(),
  };
  const useKaiSession = Object.assign(
    vi.fn((selector?: (value: typeof state) => unknown) =>
      typeof selector === "function" ? selector(state) : state,
    ),
    { getState: vi.fn(() => state) },
  );
  return { useKaiSession, state };
});

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({ push: navigationMock.push }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: true }) }));
vi.mock("@/components/agent/agent-popover-provider", () => ({
  useOptionalAgentPopover: () => ({ expanded: agentPopoverMock.expanded }),
}));
vi.mock("@/lib/consent/use-consent-pending-summary-count", () => ({
  useConsentPendingSummaryCount: () => 0,
}));
vi.mock("@/lib/stores/kai-session-store", () => ({ useKaiSession: kaiSessionMock.useKaiSession }));

describe("Navbar bottom utilities", () => {
  beforeEach(() => {
    navigationMock.pathname = ROUTES.ONE_HOME;
    navigationMock.push.mockReset();
    agentPopoverMock.expanded = false;
  });

  it.each([
    ROUTES.ONE_HOME,
    ROUTES.GMAIL,
    ROUTES.KAI_ANALYSIS,
    ROUTES.RIA_PICKS,
    ROUTES.PROFILE,
  ])("keeps the primary bottom group stable on %s", (pathname) => {
    navigationMock.pathname = pathname;
    const { unmount } = render(<Navbar />);
    const routeNav = screen.getByRole("radiogroup", { name: "Route navigation" });

    expect(within(routeNav).getAllByRole("radio").map((radio) => radio.textContent?.trim())).toEqual([
      "One",
      "Connect",
      "Search",
    ]);
    expect(screen.queryByRole("radio", { name: "Profile" })).toBeNull();
    unmount();
  });

  it("keeps One selected inside Profile and routes the primary utilities", () => {
    navigationMock.pathname = ROUTES.PROFILE;
    render(<Navbar />);

    expect(screen.getByRole("radio", { name: "One" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "One" }));
    expect(navigationMock.push).toHaveBeenLastCalledWith(ROUTES.ONE_HOME);
  });

  it("renders a compact specialist group beside the stable primary group", () => {
    navigationMock.pathname = ROUTES.KAI_ANALYSIS;
    render(<Navbar />);
    expect(
      within(screen.getByRole("radiogroup", { name: "Route navigation" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["One", "Connect", "Search"]);
    expect(
      within(screen.getByRole("radiogroup", { name: "Workspace navigation" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["Market", "Portfolio", "Analysis"]);
    expect(screen.getByRole("radiogroup", { name: "Route navigation" }).getAttribute("style")).toContain(
      "grid-template-columns: repeat(3, minmax(0, 1fr))",
    );
    expect(screen.getByTestId("app-bottom-nav-frame").className).toContain(
      "max-w-[min(calc(100vw-2rem),42rem)]",
    );
    expect(screen.getByTestId("app-bottom-nav-frame").className).toContain(
      "justify-center",
    );
  });
});

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Navbar } from "@/components/navbar";
import { ROUTES } from "@/lib/navigation/routes";
import { INTERNAL_APP_NAVIGATION_REQUEST_EVENT } from "@/lib/utils/browser-navigation";

const navigationMock = vi.hoisted(() => ({
  pathname: "/one",
  push: vi.fn(),
}));

const agentPopoverMock = vi.hoisted(() => ({ expanded: false }));
const notificationMock = vi.hoisted(() => ({
  feedUnreadCount: 0,
  pendingConsents: 0,
}));

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
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: true }),
}));
vi.mock("@/components/agent/agent-popover-provider", () => ({
  useOptionalAgentPopover: () => ({ expanded: agentPopoverMock.expanded }),
}));
vi.mock("@/lib/consent/use-consent-pending-summary-count", () => ({
  useConsentPendingSummaryCount: () => notificationMock.pendingConsents,
}));
vi.mock("@/lib/feed/use-feed-unread-count", () => ({
  useFeedUnreadCount: () => notificationMock.feedUnreadCount,
}));
vi.mock("@/lib/stores/kai-session-store", () => ({
  useKaiSession: kaiSessionMock.useKaiSession,
}));

describe("Navbar bottom utilities", () => {
  beforeEach(() => {
    navigationMock.pathname = ROUTES.ONE_HOME;
    navigationMock.push.mockReset();
    agentPopoverMock.expanded = false;
    notificationMock.feedUnreadCount = 0;
    notificationMock.pendingConsents = 0;
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
    const routeNav = screen.getByRole("radiogroup", {
      name: "Route navigation",
    });

    expect(
      within(routeNav)
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["One", "Connect", "Feed", "Search"]);
    expect(screen.queryByRole("radio", { name: "Profile" })).toBeNull();
    unmount();
  });

  it("keeps One selected inside Profile and routes the primary utilities", () => {
    navigationMock.pathname = ROUTES.PROFILE;
    render(<Navbar />);
    const onNavigationRequest = vi.fn();
    window.addEventListener(
      INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
      onNavigationRequest,
    );

    expect(
      screen.getByRole("radio", { name: "One" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: "One" })
        .querySelector('[data-segment-icon-variant="active"]'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: "Connect" })
        .querySelector('[data-segment-icon-variant="default"]'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "One" }));
    expect(onNavigationRequest).toHaveBeenCalledTimes(1);
    expect(
      (onNavigationRequest.mock.calls[0][0] as CustomEvent).detail,
    ).toMatchObject({
      href: ROUTES.ONE_HOME,
      source: "tap",
    });
    window.removeEventListener(
      INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
      onNavigationRequest,
    );
  });

  it("keeps Finance workspace navigation out of the bottom bar", () => {
    navigationMock.pathname = ROUTES.KAI_ANALYSIS;
    render(<Navbar />);
    expect(
      within(screen.getByRole("radiogroup", { name: "Route navigation" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["One", "Connect", "Feed", "Search"]);
    expect(
      screen.queryByRole("radiogroup", { name: "Workspace navigation" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("radiogroup", { name: "Route navigation" })
        .getAttribute("style"),
    ).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
    expect(
      screen.getByTestId("app-bottom-nav-frame").getAttribute("style"),
    ).toContain("var(--app-bottom-shell-max-width)");
    expect(screen.getByTestId("app-bottom-nav-frame").className).toContain(
      "justify-center",
    );
  });

  // Regression: a `lg:hidden` was added to the nav root in a chrome-polish pass,
  // which removed the primary navigation entirely above 1024px. Nothing renders
  // One / Connect / Feed / Search at desktop widths, so the bar must never be
  // gated behind a viewport breakpoint.
  it.each(["fixed", "slot"] as const)(
    "renders the %s bottom nav at every viewport width",
    (layout) => {
      const { container } = render(<Navbar layout={layout} />);
      const nav = container.querySelector("[data-app-bottom-nav]");

      expect(nav).not.toBeNull();
      expect(nav?.className).not.toMatch(/(^|\s|:)hidden(\s|$)/);
    },
  );

  it("places pending consent and unread Feed counts on Feed, not One", () => {
    notificationMock.pendingConsents = 3;
    notificationMock.feedUnreadCount = 2;
    render(<Navbar />);

    expect(
      within(screen.getByRole("radio", { name: "5 Feed" })).getByText("5"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("radio", { name: "One" })).queryByText("5"),
    ).toBeNull();
  });
});

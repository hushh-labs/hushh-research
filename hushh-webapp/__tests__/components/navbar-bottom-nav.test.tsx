import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Navbar } from "@/components/navbar";
import { ROUTES } from "@/lib/navigation/routes";
import { INTERNAL_APP_NAVIGATION_REQUEST_EVENT } from "@/lib/utils/browser-navigation";
import { BOTTOM_NAVIGATION_ICONS } from "@/components/icons";
import definitions from "@/components/icons/bottom-navigation-icons.json";
import { renderNavigationArtwork } from "@/components/icons/native-navigation-artwork.mjs";

const navigationMock = vi.hoisted(() => ({
  pathname: "/one",
  push: vi.fn(),
}));

const notificationMock = vi.hoisted(() => ({
  feedUnreadCount: 0 as number | null,
  pendingConsents: 0 as number | null,
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
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: navigationMock.push }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: true }),
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
    notificationMock.feedUnreadCount = 0;
    notificationMock.pendingConsents = 0;
  });

  it("projects the actual web glyphs and selected weights into native artwork without cropping", () => {
    function geometry(element: Element): unknown {
      return {
        tag: element.localName,
        attributes: Object.fromEntries(Array.from(element.attributes)
          .filter((attribute) => attribute.name !== "xmlns")
          .map((attribute) => [attribute.name, attribute.value])),
        children: Array.from(element.children).map(geometry),
      };
    }
    for (const key of Object.keys(definitions) as (keyof typeof definitions)[]) {
      for (const selected of [false, true]) {
        const option = BOTTOM_NAVIGATION_ICONS[key];
        const Icon = selected ? option.activeIcon ?? option.icon : option.icon;
        const view = render(<Icon />);
        const svg = view.container.querySelector("svg")!;
        const native = new DOMParser().parseFromString(
          renderNavigationArtwork(definitions[key], selected), "image/svg+xml",
        ).documentElement;
        expect(svg.getAttribute("viewBox")).toBe("0 0 256 256");
        expect(native.getAttribute("viewBox")).toBe(svg.getAttribute("viewBox"));
        // Compare two independent renderers, not a markup snapshot. Registry
        // alias/weight drift must fail even when regenerated assets are fresh.
        expect(Array.from(native.children).map(geometry)).toEqual(Array.from(svg.children).map(geometry));
        view.unmount();
      }
    }
  });

  it("retires route navigation while the owning shell hides it", () => {
    const { rerender } = render(<Navbar shellNavigationHidden />);
    expect(screen.queryByRole("radiogroup", { name: "Route navigation" })).toBeNull();
    rerender(<Navbar shellNavigationHidden={false} />);
    expect(screen.getByRole("radiogroup", { name: "Route navigation" })).toBeInTheDocument();
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
    ).toEqual(["Chat", "One", "Connect", "Feed", "Search"]);
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
    ).toEqual(["Chat", "One", "Connect", "Feed", "Search"]);
    expect(
      screen.queryByRole("radiogroup", { name: "Workspace navigation" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("radiogroup", { name: "Route navigation" })
        .getAttribute("style"),
    ).toContain("grid-template-columns: repeat(5, minmax(0, 1fr))");
    expect(screen.getByTestId("app-bottom-nav-frame").className).toContain(
      "max-w-[var(--app-bottom-shell-max-width)]",
    );
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

  it("uses one attention dot when pending and unread notification sets overlap", () => {
    notificationMock.pendingConsents = 3;
    notificationMock.feedUnreadCount = 2;
    render(<Navbar />);

    expect(screen.getByRole("radio", { name: "New activity Feed" })).toBeInTheDocument();
    expect(screen.queryByText("5")).toBeNull();
  });

  it.each([
    { pending: null, unread: 2 },
    { pending: 4, unread: null },
  ])(
    "keeps the attention dot while the other notification source is loading ($pending/$unread)",
    ({ pending, unread }) => {
      notificationMock.pendingConsents = pending;
      notificationMock.feedUnreadCount = unread;
      render(<Navbar />);

      expect(
        screen.getByRole("radio", { name: "New activity Feed" }),
      ).toBeInTheDocument();
    },
  );

  it("keeps unresolved consent work badged after chronological Feed rows are read", () => {
    notificationMock.pendingConsents = 3;
    notificationMock.feedUnreadCount = 0;
    render(<Navbar />);

    expect(
      screen.getByRole("radio", { name: "New activity Feed" }),
    ).toBeInTheDocument();
  });

  it("removes the attention dot only after both sources settle at zero", () => {
    notificationMock.pendingConsents = 0;
    notificationMock.feedUnreadCount = 0;
    render(<Navbar />);

    expect(screen.getByRole("radio", { name: "Feed" })).toBeInTheDocument();
    expect(screen.queryByText("New activity")).toBeNull();
  });
});

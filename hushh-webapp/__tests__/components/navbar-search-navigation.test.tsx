import { useSyncExternalStore } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Navbar } from "@/components/navbar";
import { KaiCommandBarGlobal } from "@/components/kai/kai-command-bar-global";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { openKaiCommandBar } from "@/lib/navigation/kai-command-bar-events";
import { ROUTES } from "@/lib/navigation/routes";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import {
  INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
  requestInternalAppNavigation,
  type InternalAppNavigationRequest,
} from "@/lib/utils/browser-navigation";

const mocks = vi.hoisted(() => {
  const session = {
    busyOperations: {},
    setAgentNavigationContext: vi.fn(),
    setLastKaiPath: vi.fn(),
    setLastRiaPath: vi.fn(),
    setAnalysisParams: vi.fn(),
    analysisParams: null,
  };
  return {
    session,
    router: { prefetch: vi.fn() },
    openAgent: vi.fn(),
    createHandoff: vi.fn((value) => value),
    runGoal: vi.fn(),
    cache: { get: vi.fn(() => null), subscribe: () => () => {} },
    background: { tasks: [] },
  };
});

// Only Next's URL commit boundary is simulated. The production navbar, Search
// host, palette, visibility rules, and navigation request functions run together.
function subscribeUrl(listener: () => void) {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
function useTestUrl() {
  return useSyncExternalStore(subscribeUrl, () => window.location.href);
}
vi.mock("next/navigation", () => ({
  usePathname: () => new URL(useTestUrl()).pathname,
  useSearchParams: () => new URL(useTestUrl()).searchParams,
  useRouter: () => mocks.router,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "search-fixture" }, isAuthenticated: true, loading: false }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: true }),
}));
vi.mock("@/components/agent/agent-popover-provider", () => ({
  useOptionalAgentPopover: () => ({ expanded: false, openAgent: mocks.openAgent }),
}));
vi.mock("@/lib/consent/use-consent-pending-summary-count", () => ({ useConsentPendingSummaryCount: () => 0 }));
vi.mock("@/lib/feed/use-feed-unread-count", () => ({ useFeedUnreadCount: () => 0 }));
vi.mock("@/lib/stores/kai-session-store", () => ({
  useKaiSession: Object.assign((selector: (state: typeof mocks.session) => unknown) => selector(mocks.session), { getState: () => mocks.session }),
}));
vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({ activePersona: "investor", primaryNavPersona: "investor" }),
}));
vi.mock("@/lib/services/cache-service", () => ({
  CacheService: { getInstance: () => mocks.cache },
  CACHE_KEYS: { PORTFOLIO_DATA: () => "portfolio", DOMAIN_DATA: () => "domain" },
}));
vi.mock("@/lib/services/debate-run-manager", () => ({
  DebateRunManagerService: { getActiveTaskForUser: () => null },
}));
vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: { getState: () => mocks.background, subscribe: () => () => {} },
}));
vi.mock("@/lib/agent/one-conversation-session", () => ({
  useOneConversationSession: (selector: (state: { createHandoff: typeof mocks.createHandoff }) => unknown) => selector({ createHandoff: mocks.createHandoff }),
}));
vi.mock("@/lib/agent/agent-runtime-context", () => ({ useAgentRuntimeStateOptional: () => null }));
vi.mock("@/lib/agent/app-goal-client", () => ({ startAppGoal: mocks.runGoal }));
vi.mock("@/lib/kai/ticker-universe-cache", () => ({
  getTickerUniverseSnapshot: () => [],
  preloadTickerUniverse: async () => [],
  searchTickerUniverseRemote: async () => [],
  searchTickerUniverse: () => [],
}));

function Shell() {
  const pathname = new URL(useTestUrl()).pathname;
  return <><Navbar shellNavigationHidden={getKaiChromeState(pathname).hideCommandBar} /><KaiCommandBarGlobal /></>;
}

const requests: InternalAppNavigationRequest[] = [];
function commitNavigation(event: Event) {
  const detail = (event as CustomEvent<InternalAppNavigationRequest>).detail;
  requests.push(detail);
  window.history[detail.replace ? "replaceState" : "pushState"]({}, "", detail.href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
function navigate(href: string) {
  act(() => { requestInternalAppNavigation({ href, source: "tap" }); });
}

describe("Search navigation through the shared shell", () => {
  beforeEach(() => {
    requests.length = 0;
    window.history.replaceState({}, "", ROUTES.HOME);
    window.addEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, commitNavigation);
  });
  afterEach(() => window.removeEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, commitNavigation));

  it("selects Search immediately while its URL commit is pending", () => {
    window.removeEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, commitNavigation);
    let intentId = "";
    const deferNavigation = (event: Event) => {
      const detail = (event as CustomEvent<InternalAppNavigationRequest>).detail;
      intentId = appInteractionCoordinator.requestNavigation({
        target: detail.href,
        source: "search",
        start: () => () => {},
      }).id;
    };
    window.addEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, deferNavigation);
    try {
      render(<Shell />);
      expect(screen.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByRole("radio", { name: "Search" }));
      expect(window.location.search).toBe("");
      expect(screen.getByRole("radio", { name: "Search" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "false");
      act(() => appInteractionCoordinator.cancelNavigation(intentId, "test_cancel"));
      expect(screen.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "true");
    } finally {
      window.removeEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, deferNavigation);
      act(() => appInteractionCoordinator.cancelNavigation(intentId, "test_cleanup"));
    }
  });

  it.each([ROUTES.HOME, ROUTES.ONE_HOME, ROUTES.CONNECT, ROUTES.ONE_FEED])(
    "opens Search on the first click from %s and selects only Search",
    async (pathname) => {
      window.history.replaceState({}, "", pathname);
      render(<Shell />);
      fireEvent.click(screen.getByRole("radio", { name: "Search" }));
      expect(await screen.findByRole("dialog", { name: "Search or ask One" })).toBeVisible();
      expect(window.location.pathname).toBe(pathname);
      expect(window.location.search).toBe("?search=1");
      expect(requests).toHaveLength(1);
      const selected = screen.getAllByRole("radio", { hidden: true }).filter(el => el.getAttribute("aria-checked") === "true");
      expect(selected).toHaveLength(1);
      expect(selected[0]).toHaveTextContent("Search");
      act(() => openKaiCommandBar());
      expect(requests).toHaveLength(1);
    },
  );

  it("restores Search on refresh/remount and follows Back and Forward", async () => {
    const view = render(<Shell />);
    fireEvent.click(screen.getByRole("radio", { name: "Search" }));
    view.unmount();
    render(<Shell />);
    expect(await screen.findByRole("dialog")).toBeVisible();
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => window.history.forward());
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("preserves finance open requests without putting the query in the URL", async () => {
    render(<Shell />);
    act(() => openKaiCommandBar({ intent: "finance_stock_analysis", initialQuery: "Analyze AAPL" }));
    expect(await screen.findByRole("combobox")).toHaveValue("Analyze AAPL");
    expect(window.location.search).toBe("?search=1");
  });

  it("ignores open requests while Search is unavailable", () => {
    window.history.replaceState({}, "", ROUTES.LOGIN);
    render(<Shell />);
    act(() => openKaiCommandBar());
    expect(requests).toHaveLength(0);
    navigate(ROUTES.HOME);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it.each([ROUTES.HOME, ROUTES.ONE_HOME, ROUTES.CONNECT, ROUTES.ONE_FEED])(
    "closes Search when navigating to %s without a stale return navigation",
    async (href) => {
      render(<Shell />);
      fireEvent.click(screen.getByRole("radio", { name: "Search" }));
      expect(await screen.findByRole("dialog")).toBeVisible();
      navigate(href);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(window.location.pathname).toBe(href);
      expect(window.location.search).toBe("");
    },
  );

  it("dismisses in place, preserves unrelated URL state, and reopens immediately", async () => {
    window.history.replaceState({}, "", `${ROUTES.CONNECT}?view=incoming#requests`);
    render(<Shell />);
    fireEvent.click(screen.getByText("Search"));
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.search).toBe("?view=incoming");
    expect(window.location.hash).toBe("#requests");
    expect(requests.at(-1)?.replace).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Search" }).querySelector("svg")!);
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it.each([
    ["Chat", ROUTES.HOME],
    ["One", ROUTES.ONE_HOME],
    ["Connect", ROUTES.CONNECT],
    ["Feed", ROUTES.ONE_FEED],
  ])("keeps the %s button working after Search dismissal", async (label, href) => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("radio", { name: "Search" }));
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("radio", { name: label }));
    expect(window.location.pathname).toBe(href);
    expect(screen.getByRole("radio", { name: label })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Search" })).toHaveAttribute("aria-checked", "false");
    expect(requests).toHaveLength(3);
  });

  it("closes Search before handing a typed prompt to Chat", async () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("radio", { name: "Search" }));
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "Help me plan tomorrow" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe(ROUTES.HOME);
    expect(mocks.createHandoff).toHaveBeenCalledWith({ reason: "user_requested", transcript: "Help me plan tomorrow" });
  });
});

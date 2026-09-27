/**
 * KaiFlow: the "import complete" card after a brokerage statement import.
 *
 * Regression (UAT, 2026-09-27): after a Schwab statement finished extracting
 * inside Finance setup, "Review Extracted Portfolio" navigated to
 * ?stage=reviewing and was pushed straight back to ?stage=import_complete,
 * and "Cancel" left the card on screen. The navigation mock below updates
 * useSearchParams on router.push, exactly like the app router, because that
 * update is what re-ran the snapshot restore and undid the review click.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SETUP_PATH = "/one/setup/finance/import";
const USER_ID = "user-synthetic-1";

const nav = vi.hoisted(() => {
  let search = "";
  const listeners = new Set<() => void>();
  const hrefs: string[] = [];
  const navigate = (href: string) => {
    hrefs.push(href);
    const [path, query = ""] = href.split("?");
    if (path !== "/one/setup/finance/import") return;
    search = query;
    listeners.forEach((listener) => listener());
  };
  return {
    hrefs,
    navigate,
    getSearch: () => search,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => {
      search = "";
      hrefs.length = 0;
    },
  };
});

const setup = vi.hoisted(() => ({
  onSetupSourceSettled: vi.fn(async () => true),
}));

vi.mock("next/navigation", async () => {
  const React = await import("react");
  const router = {
    push: (href: string) => nav.navigate(href),
    replace: (href: string) => nav.navigate(href),
    back: () => undefined,
    prefetch: () => undefined,
    refresh: () => undefined,
  };
  return {
    useRouter: () => router,
    usePathname: () => "/one/setup/finance/import",
    useSearchParams: () => {
      const search = React.useSyncExternalStore(nav.subscribe, nav.getSearch);
      return React.useMemo(() => new URLSearchParams(search), [search]);
    },
  };
});

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: "synthetic-vault-key",
    vaultOwnerToken: "synthetic-owner-token",
    tokenExpiresAt: null,
    unlockVault: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "user-synthetic-1" } }),
}));

vi.mock("@/lib/cache/cache-context", () => ({
  useCache: () => ({
    getPortfolioData: () => null,
    setPortfolioData: vi.fn(),
    invalidateDomain: vi.fn(),
  }),
}));

vi.mock("@/lib/kai/kai-financial-resource", () => ({
  useKaiFinancialResource: () => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn(async () => null),
  }),
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: () => undefined,
  useVoiceSurfaceControlTracking: () => ({
    activeControlId: null,
    lastInteractedControlId: null,
  }),
}));

vi.mock("@/lib/navigation/use-scroll-reset", () => ({
  useScrollReset: () => undefined,
  scrollAppToTop: () => undefined,
}));

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    dismissTask: vi.fn(),
    startTask: vi.fn(() => "task-synthetic"),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    failTask: vi.fn(),
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    cancelPortfolioImportRun: vi.fn(
      async () => new Response(null, { status: 404 }),
    ),
    getActivePortfolioImportRun: vi.fn(
      async () => new Response(JSON.stringify({ run: null }), { status: 200 }),
    ),
  },
}));

vi.mock("@/lib/observability/client", () => ({ trackEvent: vi.fn() }));

vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));

vi.mock("@/components/kai/views/portfolio-review-view", () => ({
  PortfolioReviewView: ({ portfolioData }: { portfolioData: { holdings?: unknown[] } }) => (
    <div data-testid="portfolio-review">
      review holdings: {portfolioData.holdings?.length ?? 0}
    </div>
  ),
}));

vi.mock("@/components/kai/views/portfolio-import-view", () => ({
  PortfolioImportView: () => <div data-testid="portfolio-import-chooser" />,
}));

vi.mock("@/components/kai/views/dashboard-master-view", () => ({
  DashboardMasterView: () => null,
}));

vi.mock("@/components/kai/views/analysis-view", () => ({
  AnalysisView: () => null,
}));

import { KaiFlow } from "@/components/kai/kai-flow";

// Synthetic, Schwab-shaped extraction result. Not a real person's holdings.
function syntheticParsedPortfolio() {
  return {
    account_info: { brokerage: "Charles Schwab", account_number: "XXXX-0000" },
    holdings: [
      { symbol: "AAA", name: "Synthetic Equity A", quantity: 10, market_value: 1000 },
      { symbol: "BBB", name: "Synthetic Equity B", quantity: 5, market_value: 500 },
    ],
  };
}

type Platform = "web" | "native";
const SNAPSHOT_KEY = "kai_portfolio_import_background_v1";

// Web keeps the snapshot in sessionStorage; the Capacitor shell keeps it in
// localStorage under a session prefix (lib/utils/session-storage.ts).
function snapshotStore(platform: Platform) {
  return platform === "native"
    ? { storage: window.localStorage, key: `_session_${SNAPSHOT_KEY}` }
    : { storage: window.sessionStorage, key: SNAPSHOT_KEY };
}

function setPlatform(platform: Platform) {
  const host = window as unknown as {
    Capacitor?: { isNativePlatform: () => boolean };
  };
  if (platform === "native") {
    host.Capacitor = { isNativePlatform: () => true };
  } else {
    delete host.Capacitor;
  }
}

function seedCompletedImport(platform: Platform, runId: string | null) {
  const { storage, key } = snapshotStore(platform);
  storage.setItem(
    key,
    JSON.stringify({
      version: 1,
      userId: USER_ID,
      taskId: "task-synthetic",
      runId,
      latestCursor: 19,
      status: "completed",
      startedAt: "2026-09-27T10:48:29.000Z",
      updatedAt: "2026-09-27T10:50:12.000Z",
      errorMessage: null,
      streaming: {
        stage: "complete",
        stageTrail: [],
        rawStreamLines: [],
        holdingsExtracted: 2,
        holdingsTotal: 2,
      },
      parsedPortfolio: syntheticParsedPortfolio(),
    }),
  );
}

function renderSetupImportFlow() {
  return render(
    <KaiFlow
      userId={USER_ID}
      mode="import"
      vaultOwnerToken="synthetic-owner-token"
      onSetupSourceSettled={setup.onSetupSourceSettled}
      deferSensitiveActionsUntilSetupFinalized
      voicePublisherRole="chrome"
    />,
  );
}

describe.each<Platform>(["web", "native"])(
  "KaiFlow import complete card (%s)",
  (platform) => {
    beforeEach(() => {
      nav.reset();
      window.sessionStorage.clear();
      window.localStorage.clear();
      setPlatform(platform);
      setup.onSetupSourceSettled.mockClear();
    });

    afterEach(() => {
      setPlatform("web");
      window.sessionStorage.clear();
      window.localStorage.clear();
    });

    it("opens the review after a completed import and stays there", async () => {
      seedCompletedImport(platform, "import_run_synthetic");
      renderSetupImportFlow();

      fireEvent.click(await screen.findByText("Review Extracted Portfolio"));

      expect(await screen.findByTestId("portfolio-review")).toBeTruthy();
      // Outlast the 700 ms snapshot poll and any restore re-run.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
      });
      expect(screen.getByTestId("portfolio-review").textContent).toContain(
        "review holdings: 2",
      );
      expect(screen.queryByText("Review Extracted Portfolio")).toBeNull();
      expect(nav.getSearch()).toBe("stage=reviewing");
    });

    it("reopens the review on reload of ?stage=reviewing with a run the backend no longer knows", async () => {
      // A cancelled or cross-instance run id is irrelevant once extraction is
      // stored locally; reload must not bounce the person back to the card.
      seedCompletedImport(platform, "import_run_stale_or_cancelled");
      nav.navigate(`${SETUP_PATH}?stage=reviewing`);
      renderSetupImportFlow();

      expect(await screen.findByTestId("portfolio-review")).toBeTruthy();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
      });
      expect(screen.queryByText("Review Extracted Portfolio")).toBeNull();
      expect(nav.getSearch()).toBe("stage=reviewing");
    });

    it("cancel discards the extracted result and returns to the source chooser in setup", async () => {
      seedCompletedImport(platform, "import_run_synthetic");
      renderSetupImportFlow();

      fireEvent.click(await screen.findByText("Cancel"));

      expect(await screen.findByTestId("portfolio-import-chooser")).toBeTruthy();
      expect(setup.onSetupSourceSettled).toHaveBeenCalledWith(
        "later",
        undefined,
      );
      const { storage, key } = snapshotStore(platform);
      expect(storage.getItem(key)).toBeNull();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
      });
      expect(screen.queryByText("Review Extracted Portfolio")).toBeNull();
      await waitFor(() =>
        expect(nav.getSearch()).toBe("stage=import_required"),
      );
    });
  },
);

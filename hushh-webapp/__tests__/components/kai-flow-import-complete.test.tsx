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
  syncOnboardingJourney: vi.fn(),
}));
const importStream = vi.hoisted(() => vi.fn());
const scrollReset = vi.hoisted(() => vi.fn());

vi.mock("@/lib/services/kai-token-guard", () => ({
  ensureKaiVaultOwnerToken: vi.fn(async () => "synthetic-owner-token"),
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: vi.fn(async () => ({ setupCompleted: true })),
    isSetupResolved: (state: { setupCompleted?: boolean }) => state.setupCompleted === true,
    syncOnboardingJourney: setup.syncOnboardingJourney,
  },
}));

vi.mock("@/lib/kai/plaid-vault/vault-sync", () => ({
  createVaultLink: vi.fn(async () => ({ linkToken: "synthetic-link", platform: "web" })),
  rememberVaultOAuthReturn: vi.fn(),
  sealVaultPlaidConnection: vi.fn(async () => ({ status: null })),
}));

vi.mock("@/lib/kai/brokerage/plaid-link-loader", () => ({
  loadPlaidLink: vi.fn(async () => ({
    create: ({ onSuccess }: { onSuccess: (token: string) => void }) => ({
      open: () => onSuccess("synthetic-public-token"),
      destroy: vi.fn(),
    }),
  })),
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

vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: () => undefined,
  useVoiceSurfaceControlTracking: () => ({
    activeControlId: null,
    lastInteractedControlId: null,
  }),
}));

vi.mock("@/lib/navigation/use-scroll-reset", () => ({
  useScrollReset: scrollReset,
  scrollAppToTop: () => undefined,
}));

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    hasRunningTask: vi.fn(() => false),
    getState: vi.fn(() => ({ tasks: [] })),
    dismissTask: vi.fn(),
    startTask: vi.fn(() => "task-synthetic"),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    failTask: vi.fn(),
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    importPortfolioStream: importStream,
    cancelPortfolioImportRun: vi.fn(
      async () => new Response(null, { status: 404 }),
    ),
    streamPortfolioImportRun: vi.fn(),
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
  PortfolioReviewView: ({ portfolioData, onReimport }: { portfolioData: { holdings?: unknown[] }; onReimport: () => void }) => (
    <div data-testid="portfolio-review">
      review holdings: {portfolioData.holdings?.length ?? 0}
      <button type="button" onClick={onReimport}>Start over</button>
    </div>
  ),
}));

vi.mock("@/components/kai/views/portfolio-import-view", () => ({
  PortfolioImportView: ({
    onPreloadSchema,
    onConnectPlaid,
    onFileSelect,
  }: {
    onPreloadSchema?: () => void;
    onConnectPlaid?: () => void;
    onFileSelect?: (file: File) => void;
  }) => (
    <div data-testid="portfolio-import-chooser">
      <button type="button" onClick={() => onFileSelect?.(new File(["%PDF synthetic"], "statement.pdf", { type: "application/pdf" }))}>Upload statement</button>
      <button type="button" onClick={() => onPreloadSchema?.()}>
        Load sample brokerage
      </button>
      <button type="button" onClick={() => onConnectPlaid?.()}>
        Connect brokerage
      </button>
    </div>
  ),
}));

vi.mock("@/lib/services/demo-mode-template-service", () => ({
  fetchDemoPortfolioTemplateAsset: vi.fn(async () => syntheticParsedPortfolio()),
}));

vi.mock("@/components/kai/views/dashboard-master-view", () => ({
  DashboardMasterView: () => null,
}));

vi.mock("@/components/kai/views/analysis-view", () => ({
  AnalysisView: () => null,
}));

import { KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS } from "@/lib/services/kai-import-stream-config";
import { ApiService } from "@/lib/services/api-service";
import { KaiFlow } from "@/components/kai/kai-flow";
import { ROUTES } from "@/lib/navigation/routes";

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

function renderSetupImportFlow(vaultKey?: string) {
  return render(
    <KaiFlow
      userId={USER_ID}
      mode="import"
      vaultOwnerToken="synthetic-owner-token"
      vaultKey={vaultKey}
      onSetupSourceSettled={setup.onSetupSourceSettled}
      deferSensitiveActionsUntilSetupFinalized
      voicePublisherRole="chrome"
    />,
  );
}

describe.each<Platform>(["web", "native"])(
  "KaiFlow statement review (%s)",
  (platform) => {
    beforeEach(() => {
      nav.reset();
      window.sessionStorage.clear();
      window.localStorage.clear();
      setPlatform(platform);
      setup.onSetupSourceSettled.mockClear();
      setup.syncOnboardingJourney.mockClear();
      importStream.mockReset();
      vi.mocked(ApiService.streamPortfolioImportRun).mockReset();
      scrollReset.mockClear();
    });

    afterEach(() => {
      setPlatform("web");
      window.sessionStorage.clear();
      window.localStorage.clear();
    });

    it("cancel during active-run precheck never cancels a late run or starts upload", async () => {
      let resolvePrecheck!: (value: Response) => void;
      vi.mocked(ApiService.getActivePortfolioImportRun).mockImplementationOnce(() => new Promise(resolve => { resolvePrecheck = resolve; }));
      vi.mocked(ApiService.cancelPortfolioImportRun).mockClear();
      renderSetupImportFlow("synthetic-vault-key");
      fireEvent.click(await screen.findByText("Upload statement"));
      await screen.findByRole("button", { name: "Cancel", exact: true });
      await waitFor(() => expect(resolvePrecheck).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
      await act(async () => { resolvePrecheck(new Response(JSON.stringify({ run: { run_id: "late-run", status: "running" } }))); });
      expect(importStream).not.toHaveBeenCalled();
      expect(ApiService.cancelPortfolioImportRun).not.toHaveBeenCalled();
      expect(screen.getByTestId("portfolio-import-chooser")).toBeVisible();
    });

    it("resume deadline stops loading and records failure for the same attempt", async () => {
      seedCompletedImport(platform, "synthetic-resume");
      const { storage, key } = snapshotStore(platform);
      const snapshot = JSON.parse(storage.getItem(key)!);
      snapshot.status = "running";
      snapshot.streaming.stage = "extracting";
      delete snapshot.parsedPortfolio;
      storage.setItem(key, JSON.stringify(snapshot));
      vi.mocked(ApiService.streamPortfolioImportRun).mockImplementation(({ signal }) => new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
      }));
      const timeoutSpy = vi.spyOn(window, "setTimeout");
      const view = renderSetupImportFlow("synthetic-vault-key");
      try {
        await waitFor(() => expect(ApiService.streamPortfolioImportRun).toHaveBeenCalledOnce());
        const timeout = timeoutSpy.mock.calls.find(([, delay]) => delay === KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS)?.[0];
        expect(typeof timeout).toBe("function");
        await act(async () => { (timeout as () => void)(); });
        expect(await screen.findByText("Couldn’t resume reading your statement. Try importing it again.")).toBeVisible();
        expect(JSON.parse(storage.getItem(key)!).status).toBe("failed");
      } finally {
        view.unmount();
        timeoutSpy.mockRestore();
      }
    });

    it("fresh upload keeps stream ownership across route updates", async () => {
      vi.mocked(ApiService.streamPortfolioImportRun).mockClear();
      let emit!: (text: string) => void;
      const body = new ReadableStream<Uint8Array>({ start(controller) { emit = text => { controller.enqueue(new TextEncoder().encode(text)); if (text.startsWith("event: complete")) controller.close(); }; } });
      importStream.mockResolvedValue(new Response(body));
      renderSetupImportFlow("synthetic-vault-key");
      fireEvent.click(await screen.findByText("Upload statement"));
      await waitFor(() => expect(importStream).toHaveBeenCalledOnce());
      await act(async () => nav.navigate(`${SETUP_PATH}?stage=importing&review_source=statement`));
      const envelope = { schema_version: "1.0", stream_id: "synthetic-import", stream_kind: "portfolio_import", seq: 1,
        event: "complete", terminal: true, payload: { portfolio_data_v2: syntheticParsedPortfolio() } };
      await act(async () => emit(`event: complete\ndata: ${JSON.stringify(envelope)}\n\n`));
      await screen.findByTestId("portfolio-review");
      expect(ApiService.streamPortfolioImportRun).not.toHaveBeenCalled();
    });

    it("streams source facts in the review shell and excludes provisional values from recovery storage", async () => {
      let emit!: (text: string) => void;
      const body = new ReadableStream<Uint8Array>({ start(controller) { emit = text => { controller.enqueue(new TextEncoder().encode(text)); if (text.startsWith("event: complete")) controller.close(); }; } });
      importStream.mockResolvedValue(new Response(body));
      const view = renderSetupImportFlow("synthetic-vault-key");
      fireEvent.click(await screen.findByText("Upload statement"));
      await waitFor(() => expect(importStream).toHaveBeenCalledOnce());
      const envelope = { schema_version: "1.0", stream_id: "synthetic-import", stream_kind: "portfolio_import", seq: 1, event: "progress", terminal: false,
        payload: { holdings_preview: [{ symbol: "SENTINEL", name: "Sensitive provisional lot", quantity: 7 }],
          extraction_update: { version: 1, revision: 1, unit_id: "pdf:1", unit_index: 1, units_total: 2, source_kind: "pdf",
            rows: [{ source_id: "pdf:1:1", symbol: "SENTINEL", name: "Sensitive provisional lot", market_value: 17 }],
            facts: { statement_details: { institution_name: "Synthetic broker", account_number: "SENSITIVE-ACCOUNT-TEST" } } } } };
      await act(async () => emit(`event: progress\ndata: ${JSON.stringify(envelope)}\n\n`));
      expect(await screen.findByText("SENSITIVE-ACCOUNT-TEST")).toBeVisible();
      const { storage, key } = snapshotStore(platform);
      const persisted = storage.getItem(key)!;
      expect(persisted).not.toContain("SENSITIVE-ACCOUNT-TEST");
      expect(persisted).not.toContain("Sensitive provisional lot");
      expect(persisted).not.toContain("SENTINEL");
      expect(screen.queryByTestId("portfolio-review")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
      expect(screen.queryByText("SENSITIVE-ACCOUNT-TEST")).toBeNull();
      view.unmount();
    });

    it.each([false, true])("terminal import settles before review and cancellation wins (%s)", async (cancel) => {
      const envelope = { schema_version: "1.0", stream_id: "synthetic-import", stream_kind: "portfolio_import", seq: 1,
        event: "complete", terminal: true, payload: { portfolio_data_v2: syntheticParsedPortfolio() } };
      importStream.mockResolvedValue(new Response(`event: complete\ndata: ${JSON.stringify(envelope)}\n\n`, { status: 200 }));
      renderSetupImportFlow("synthetic-vault-key");
      fireEvent.click(await screen.findByText("Upload statement"));
      await screen.findByText("Ready to review");
      const readingScrollKey = scrollReset.mock.lastCall?.[0];
      expect(screen.queryByTestId("portfolio-review")).toBeNull();
      if (cancel) {
        fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
        await screen.findByTestId("portfolio-import-chooser");
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
        expect(screen.queryByTestId("portfolio-review")).toBeNull();
      } else {
        await screen.findByTestId("portfolio-review");
        expect(scrollReset.mock.lastCall?.[0]).toBe(readingScrollKey);
        expect(screen.queryByRole("button", { name: "Cancel", exact: true })).toBeNull();
      }
    });

    it.each([null, "/circle/join?invite=opaque_token", "https://outside.invalid"])(
      "resolved-root Plaid success preserves only a valid setup continuation (%s)",
      async (returnTo) => {
        if (returnTo) nav.navigate(`${SETUP_PATH}?return_to=${encodeURIComponent(returnTo)}`);
        renderSetupImportFlow();

        fireEvent.click(await screen.findByText("Connect brokerage"));

        if (returnTo?.startsWith("/circle/join")) {
          await waitFor(() => expect(setup.onSetupSourceSettled).toHaveBeenCalledWith("plaid", undefined));
          expect(nav.hrefs.some((href) => href.startsWith("/one/kai"))).toBe(false);
          expect(new URLSearchParams(nav.getSearch()).get("return_to")).toBe(returnTo);
        } else {
          await waitFor(() => expect(nav.hrefs).toContain(ROUTES.KAI_DASHBOARD));
          expect(setup.onSetupSourceSettled).not.toHaveBeenCalled();
        }
        expect(setup.syncOnboardingJourney).not.toHaveBeenCalled();
      },
    );

    it("does not navigate again when the import snapshot stays in the same stage", async () => {
      seedCompletedImport(platform, "import_run_synthetic");
      renderSetupImportFlow();
      await screen.findByTestId("portfolio-review");
      const navigationCount = nav.hrefs.length;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      });
      expect(nav.hrefs).toHaveLength(navigationCount);
      expect(nav.getSearch()).toBe("stage=reviewing");
    });

    it("opens the review after a completed import and stays there", async () => {
      seedCompletedImport(platform, "import_run_synthetic");
      renderSetupImportFlow();

      expect(await screen.findByTestId("portfolio-review")).toBeTruthy();
      // Outlast the 700 ms snapshot poll and any restore re-run.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
      });
      expect(screen.getByTestId("portfolio-review").textContent).toContain(
        "review holdings: 2",
      );
      expect(screen.queryByText("Statement ready to review")).toBeNull();
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
      expect(screen.queryByText("Statement ready to review")).toBeNull();
      expect(nav.getSearch()).toBe("stage=reviewing");
    });

    it.each([null, "/circle/join?invite=opaque_token"])("starting over retains the source chooser and invitation continuation (%s)", async (returnTo) => {
      seedCompletedImport(platform, "import_run_synthetic");
      if (returnTo) nav.navigate(`${SETUP_PATH}?return_to=${encodeURIComponent(returnTo)}`);
      renderSetupImportFlow();

      fireEvent.click(await screen.findByRole("button", { name: "Start over" }));

      expect(await screen.findByTestId("portfolio-import-chooser")).toBeTruthy();
      expect(setup.onSetupSourceSettled).not.toHaveBeenCalled();
      const { storage, key } = snapshotStore(platform);
      expect(storage.getItem(key)).toBeNull();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
      });
      expect(screen.queryByText("Statement ready to review")).toBeNull();
      await waitFor(() =>
        expect(new URLSearchParams(nav.getSearch()).get("stage")).toBe("import_required"),
      );
      expect(new URLSearchParams(nav.getSearch()).get("return_to")).toBe(returnTo);
      expect(nav.hrefs.some((href) => href.startsWith("/one/kai"))).toBe(false);
    });

    it("Load sample brokerage opens the sample review despite a stale FAILED background snapshot", async () => {
      // Regression: an earlier real statement import that errored (and was
      // never dismissed) leaves a "failed" snapshot in storage. Choosing
      // "Load sample brokerage" afterward set state to "reviewing", which
      // re-ran the restore effect via the ?stage= navigation and bounced
      // straight back to the picker with the old error toast -- from the
      // user's side, tapping the row did nothing.
      const { storage, key } = snapshotStore(platform);
      storage.setItem(
        key,
        JSON.stringify({
          version: 1,
          userId: USER_ID,
          taskId: "task-stale",
          runId: null,
          latestCursor: 0,
          status: "failed",
          startedAt: "2026-09-27T09:00:00.000Z",
          updatedAt: "2026-09-27T09:00:05.000Z",
          errorMessage: "Could not read that statement. Please try again.",
          streaming: {
            stage: "error",
            stageTrail: [],
            rawStreamLines: [],
            holdingsExtracted: 0,
            holdingsTotal: 0,
          },
          parsedPortfolio: null,
        }),
      );
      renderSetupImportFlow();

      fireEvent.click(await screen.findByText("Load sample brokerage"));

      expect(await screen.findByTestId("portfolio-review")).toBeTruthy();
      // Outlast the 700 ms snapshot poll: the stale "failed" entry must not
      // resurface and bounce the sample review back to the picker.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
      });
      expect(screen.getByTestId("portfolio-review")).toBeTruthy();
      expect(screen.queryByTestId("portfolio-import-chooser")).toBeNull();
      expect(nav.getSearch()).toBe("stage=reviewing");
      // The deliberate switch to sample data discards the stale attempt
      // rather than merely tolerating it.
      expect(storage.getItem(key)).toBeNull();
    });

    it("the sample review survives the 700ms poll finding a RUNNING snapshot from a separate import", async () => {
      // Not a stale-at-mount snapshot (that legitimately routes to the
      // importing-progress view, which is correct when a real import really
      // is running) -- this is the poll effect discovering a "running"
      // snapshot AFTER the person is already looking at the sample review,
      // e.g. a real background import elsewhere on the same account ticks
      // its snapshot while the sample review is open. That must not yank
      // the open review away either.
      const { storage, key } = snapshotStore(platform);
      renderSetupImportFlow();

      fireEvent.click(await screen.findByText("Load sample brokerage"));
      expect(await screen.findByTestId("portfolio-review")).toBeTruthy();

      storage.setItem(
        key,
        JSON.stringify({
          version: 1,
          userId: USER_ID,
          taskId: "task-concurrent-running",
          runId: "import_run_concurrent",
          latestCursor: 3,
          status: "running",
          startedAt: "2026-09-27T09:00:00.000Z",
          updatedAt: "2026-09-27T09:00:05.000Z",
          errorMessage: null,
          streaming: {
            stage: "extracting",
            stageTrail: [],
            rawStreamLines: [],
            holdingsExtracted: 1,
            holdingsTotal: 5,
          },
          parsedPortfolio: null,
        }),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
      });
      expect(screen.getByTestId("portfolio-review")).toBeTruthy();
      expect(nav.getSearch()).toBe("stage=reviewing");
    });
  },
);

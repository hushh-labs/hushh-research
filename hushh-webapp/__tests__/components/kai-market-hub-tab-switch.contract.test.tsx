/** @vitest-environment jsdom */

/**
 * Finance tab switch (Market / Portfolio / Stocks) on web.
 *
 * On web a `?tab=` change is a soft navigation, so the URL echo reaches
 * `useSearchParams` a round trip AFTER the pager has already moved. Measured
 * symptom: click Portfolio, the pane lands on Portfolio, snaps back to Market,
 * then travels to Portfolio again once the URL catches up.
 *
 * Cause: a tap only reached the pager through the shared channel, while the
 * pager's `activeValue` (`visibleTab`) followed the URL. Until the echo the
 * pager's own self-heal read the old tab as the selection and jumped back to
 * it, and the settle of the tap's motion committed the tab a second time, which
 * pre-empted the first `router.replace`.
 *
 * The contract: one click is one selection and one navigation; the pane, the
 * strip and the URL agree without an intermediate trip back to the old tab.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KaiMarketHubPage } from "@/components/kai/kai-market-hub-page";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { setTopShellTabSwipeState } from "@/lib/navigation/top-shell-tab-swipe-progress";

const SLIDE_WIDTH = 390;
const SLIDE_COUNT = 3;

const embla = vi.hoisted(() => ({
  offset: 0,
  target: 0,
  listeners: new Map<string, Set<() => void>>(),
  scrollTo: vi.fn<(index: number, jump?: boolean) => void>(),
  api: null as Record<string, unknown> | null,
  root: null as HTMLElement | null,
  container: null as HTMLElement | null,
}));

function emit(event: string) {
  embla.listeners.get(event)?.forEach((listener) => listener());
}

vi.mock("embla-carousel-react", () => ({
  default: () => {
    if (embla.api) return [vi.fn(), embla.api];
    const engine = {
      slideRects: Array.from({ length: SLIDE_COUNT }, () => ({
        width: SLIDE_WIDTH,
      })),
      scrollSnaps: Array.from(
        { length: SLIDE_COUNT },
        (_unused, index) => -(index * SLIDE_WIDTH),
      ),
      limit: { min: -((SLIDE_COUNT - 1) * SLIDE_WIDTH), max: 0 },
      containerRect: { width: SLIDE_WIDTH },
      scrollBounds: { toggleActive: vi.fn() },
      animation: { start: vi.fn() },
      target: {
        set: (value: number) => (embla.target = value),
        get: () => embla.target,
      },
      location: { set: (value: number) => (embla.offset = value) },
      offsetLocation: {
        set: (value: number) => (embla.offset = value),
        get: () => embla.offset,
      },
      previousLocation: { set: () => undefined },
      translate: { to: () => undefined },
    };
    embla.api = {
      selectedScrollSnap: () => Math.round(-embla.target / SLIDE_WIDTH),
      scrollProgress: () =>
        -embla.offset / ((SLIDE_COUNT - 1) * SLIDE_WIDTH),
      // Real Embla retargets and emits `select` synchronously from scrollTo.
      scrollTo: (index: number, jump?: boolean) => {
        embla.scrollTo(index, jump);
        embla.target = -index * SLIDE_WIDTH;
        if (jump) embla.offset = embla.target;
        emit("select");
      },
      reInit: vi.fn(),
      internalEngine: () => engine,
      containerNode: () => embla.container ?? document.body,
      rootNode: () => embla.root ?? document.body,
      on: (event: string, listener: () => void) => {
        const set = embla.listeners.get(event) ?? new Set<() => void>();
        set.add(listener);
        embla.listeners.set(event, set);
      },
      off: (event: string, listener: () => void) => {
        embla.listeners.get(event)?.delete(listener);
      },
    };
    return [vi.fn(), embla.api];
  },
}));

// A controllable URL: `router.replace` records the request and does NOT apply
// it, exactly like a soft navigation that has not returned yet.
const url = vi.hoisted(() => ({
  tab: "market",
  listeners: new Set<() => void>(),
  replace: vi.fn<(href: string) => void>(),
}));

function echoUrl(tab: string) {
  act(() => {
    // The route settling is what ends the navigation intent in the app.
    for (const intent of appInteractionCoordinator.getSnapshot()) {
      if (intent.status === "accepted" || intent.status === "committing") {
        appInteractionCoordinator.settleNavigation(intent.id);
      }
    }
    url.tab = tab;
    url.listeners.forEach((listener) => listener());
  });
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: url.replace, push: vi.fn() }),
  useSearchParams: () => {
    const tab = useSyncExternalStore(
      (listener) => {
        url.listeners.add(listener);
        return () => url.listeners.delete(listener);
      },
      () => url.tab,
      () => url.tab,
    );
    return new URLSearchParams({ tab });
  },
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: { uid: "user-1" },
    userId: "user-1",
    loading: false,
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: null, vaultOwnerToken: null }),
}));
vi.mock("@/lib/progress/step-progress-context", () => ({
  useStepProgress: () => ({
    registerSteps: vi.fn(),
    completeStep: vi.fn(),
    reset: vi.fn(),
  }),
}));
vi.mock("@/lib/kai/finance-workspace-warmup", () => ({
  scheduleFinanceWorkspaceWarmup: () => () => undefined,
}));
vi.mock("@/components/kai/kai-flow", () => ({
  KaiFlow: () => <div>Portfolio panel</div>,
}));
vi.mock("@/components/kai/views/kai-preview-router", () => ({
  KaiPreviewRouter: () => <div>Market panel</div>,
}));
vi.mock("@/app/one/kai/analysis/page", () => ({
  KaiAnalysisPageContent: () => <div>Stocks panel</div>,
}));
vi.mock("@/components/kai/shared/kai-market-home-context", () => ({
  KaiMarketHomeProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));

// Frames run after the handler that scheduled them, as in a browser. Running
// them inline would reorder the pager's self-heal ahead of Embla's own settle
// handling and hide the snap back this file exists to catch.
let frames: FrameRequestCallback[] = [];

function flushFrames() {
  act(() => {
    for (let pass = 0; pass < 5 && frames.length > 0; pass += 1) {
      const pending = frames;
      frames = [];
      pending.forEach((callback) => callback(0));
    }
  });
}

/** Lets the pane finish its flight, the way Embla's spring converges. */
function finishPaneMotion() {
  act(() => {
    embla.offset = embla.target;
    emit("scroll");
    emit("settle");
  });
  flushFrames();
}

/** Every href handed to `router.replace`, in order. */
function replaced() {
  return url.replace.mock.calls.map(([href]) => href);
}

function strip() {
  return screen.getByRole("tablist", { name: /finance navigation/i });
}

function selectedTab() {
  return strip().querySelector('[role="tab"][aria-selected="true"]')
    ?.textContent;
}

beforeEach(() => {
  embla.offset = 0;
  embla.target = 0;
  embla.listeners.clear();
  embla.scrollTo.mockClear();
  embla.api = null;
  embla.root = document.createElement("div");
  embla.root.getBoundingClientRect = () =>
    ({ width: SLIDE_WIDTH, height: 800 }) as DOMRect;
  embla.container = document.createElement("div");
  for (let index = 0; index < SLIDE_COUNT; index += 1) {
    embla.container.appendChild(document.createElement("div"));
  }
  url.tab = "market";
  url.listeners.clear();
  url.replace.mockReset();
  setTopShellTabSwipeState("finance", 0, false);
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  for (const intent of appInteractionCoordinator.getSnapshot()) {
    appInteractionCoordinator.cancelNavigation(intent.id, "test_cleanup");
  }
  vi.unstubAllGlobals();
});

describe("Finance tab switch — URL echo lags the pane", () => {
  it("clicks Portfolio once: no snap back to Market and one navigation", () => {
    render(<KaiMarketHubPage />);
    flushFrames();
    expect(selectedTab()).toBe("Market");

    fireEvent.click(screen.getByRole("tab", { name: "Portfolio" }));
    flushFrames();

    // The strip answers the click at once, and the pane starts for Portfolio.
    expect(selectedTab()).toBe("Portfolio");
    expect(embla.scrollTo.mock.calls).toEqual([[1, undefined]]);
    expect(replaced()).toEqual(["/one/kai?tab=portfolio"]);

    // The pane settles BEFORE the URL has caught up.
    finishPaneMotion();
    expect(embla.target).toBe(-SLIDE_WIDTH);
    expect(embla.offset).toBe(-SLIDE_WIDTH);
    expect(selectedTab()).toBe("Portfolio");
    // Settling a tapped pane is not a second navigation, which would pre-empt
    // the first one and restart its round trip.
    expect(replaced()).toEqual(["/one/kai?tab=portfolio"]);

    // The echo arrives: URL and state agree, and nothing moves again.
    echoUrl("portfolio");
    expect(selectedTab()).toBe("Portfolio");
    expect(embla.target).toBe(-SLIDE_WIDTH);
    expect(embla.scrollTo.mock.calls).toEqual([[1, undefined]]);
    expect(replaced()).toEqual(["/one/kai?tab=portfolio"]);
  });

  it("still commits a finger swipe to the URL exactly once", () => {
    render(<KaiMarketHubPage />);

    // The finger lands on Portfolio: Embla selects it and later settles.
    act(() => {
      embla.target = -SLIDE_WIDTH;
      emit("select");
    });
    expect(selectedTab()).toBe("Portfolio");
    finishPaneMotion();

    expect(replaced()).toEqual(["/one/kai?tab=portfolio"]);
  });

  it("follows an external URL change such as browser Back", () => {
    render(<KaiMarketHubPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Portfolio" }));
    finishPaneMotion();
    echoUrl("portfolio");

    echoUrl("market");

    expect(selectedTab()).toBe("Market");
    expect(Math.abs(embla.target)).toBe(0);
  });
});

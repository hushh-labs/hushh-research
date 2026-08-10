/** @vitest-environment jsdom */

import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmblaCarouselType } from "embla-carousel";

import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import { requestTopShellTabSelection } from "@/lib/navigation/top-shell-tab-swipe-progress";

const embla = vi.hoisted(() => ({
  selectedIndex: 0,
  scrollProgress: 0,
  scrollTo: vi.fn<(index: number) => void>(),
  reInit: vi.fn(),
  listeners: new Map<string, () => void>(),
  ref: vi.fn(),
  rootNode: null as HTMLElement | null,
  options: null as Record<string, unknown> | null,
}));

vi.mock("embla-carousel-react", () => ({
  default: (options: Record<string, unknown>) => {
    embla.options = options;
    return [
      embla.ref,
      {
        selectedScrollSnap: () => embla.selectedIndex,
        scrollProgress: () => embla.scrollProgress,
        scrollTo: embla.scrollTo,
        reInit: embla.reInit,
        rootNode: () => embla.rootNode ?? document.body,
        on: (event: string, listener: () => void) => {
          embla.listeners.set(event, listener);
        },
        off: (event: string) => {
          embla.listeners.delete(event);
        },
      },
    ];
  },
}));

const OPTIONS = [
  { value: "first", label: "First" },
  { value: "second", label: "Second" },
] as const;

describe("SwipeViews", () => {
  beforeEach(() => {
    embla.selectedIndex = 0;
    embla.scrollProgress = 0;
    embla.scrollTo.mockClear();
    embla.reInit.mockClear();
    embla.listeners.clear();
    embla.rootNode = document.createElement("div");
    embla.options = null;
  });

  it("keeps pane identity mounted while route selection changes", () => {
    const mounts = { first: 0, second: 0 };
    const cleanups = { first: 0, second: 0 };

    function Panel({ id }: { id: keyof typeof mounts }) {
      useEffect(() => {
        mounts[id] += 1;
        return () => {
          cleanups[id] += 1;
        };
      }, [id]);
      return <div>{id} panel content</div>;
    }

    const view = render(
      <SwipeViews tabSetId="demo" activeValue="first" options={OPTIONS}>
        <Panel id="first" />
        <Panel id="second" />
      </SwipeViews>,
    );

    expect(screen.getByText("first panel content")).toBeInTheDocument();
    expect(screen.getByText("second panel content")).toBeInTheDocument();
    expect(mounts).toEqual({ first: 1, second: 1 });
    expect(view.container.querySelectorAll('[role="tabpanel"]')).toHaveLength(
      2,
    );
    const pager = view.container.querySelector(
      '[data-swipe-views-root="true"]',
    );
    expect(pager).toHaveStyle(
      "min-height: calc(100dvh - var(--app-top-content-offset, 0px))",
    );
    expect(
      view.container.querySelector("#top-shell-demo-panel-first"),
    ).toHaveAttribute("aria-labelledby", "top-shell-demo-tab-first");
    expect(
      screen
        .getByText("first panel content")
        .closest("[data-morphy-enter='true']"),
    ).toBeNull();

    view.rerender(
      <SwipeViews tabSetId="demo" activeValue="second" options={OPTIONS}>
        <Panel id="first" />
        <Panel id="second" />
      </SwipeViews>,
    );

    expect(screen.getByText("first panel content")).toBeInTheDocument();
    expect(screen.getByText("second panel content")).toBeInTheDocument();
    expect(mounts).toEqual({ first: 1, second: 1 });
    expect(cleanups).toEqual({ first: 0, second: 0 });
    expect(embla.scrollTo).toHaveBeenCalledWith(1);
    expect(
      screen
        .getByText("second panel content")
        .closest("[data-morphy-enter='true']"),
    ).toBeNull();
  });

  it("reports the destination as soon as a horizontal pager selects it", () => {
    const onSelectionChange = vi.fn();
    const onSelectionCommit = vi.fn();

    render(
      <SwipeViews
        tabSetId="demo"
        activeValue="first"
        options={OPTIONS}
        onSelectionChange={onSelectionChange}
        onSelectionCommit={onSelectionCommit}
      >
        <div>first panel content</div>
        <div>second panel content</div>
      </SwipeViews>,
    );

    embla.selectedIndex = 1;
    embla.listeners.get("select")?.();

    expect(onSelectionChange).toHaveBeenCalledWith("second");

    embla.listeners.get("settle")?.();

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionCommit).toHaveBeenCalledWith("second");
    expect(embla.options).toMatchObject({
      duration: 16,
      dragThreshold: 6,
    });

    // Resize watching stays ON so a stale container measurement can correct
    // itself, but is scoped to the container: per-slide entries (streaming
    // content changing height) must not re-trigger the horizontal engine.
    const watchResize = embla.options?.watchResize as (
      api: { containerNode: () => Element },
      entries: { target: Element }[],
    ) => boolean;
    expect(typeof watchResize).toBe("function");
    const containerNode = document.createElement("div");
    const slideNode = document.createElement("div");
    const apiStub = { containerNode: () => containerNode };
    expect(watchResize(apiStub, [{ target: containerNode }])).toBe(true);
    expect(watchResize(apiStub, [{ target: slideNode }])).toBe(false);
  });

  it("starts pane motion immediately when the shared top tab is pressed", () => {
    render(
      <SwipeViews tabSetId="instant" activeValue="first" options={OPTIONS}>
        <div>first panel content</div>
        <div>second panel content</div>
      </SwipeViews>,
    );

    requestTopShellTabSelection("instant", "second");

    expect(embla.scrollTo).toHaveBeenCalledWith(1);
  });

  it("keeps the shared tab progress attached to the pane through snap settle", () => {
    const view = render(
      <SwipeViews tabSetId="continuous" activeValue="first" options={OPTIONS}>
        <div>first panel content</div>
        <div>second panel content</div>
      </SwipeViews>,
    );

    embla.listeners.get("pointerDown")?.();
    embla.scrollProgress = 0.45;
    embla.listeners.get("scroll")?.();
    embla.listeners.get("pointerUp")?.();

    const progressVariable = "--top-shell-tab-swipe-continuous-position";
    expect(
      document.documentElement.style.getPropertyValue(progressVariable),
    ).toBe("0.45");

    embla.selectedIndex = 1;
    embla.scrollProgress = 1;
    embla.listeners.get("settle")?.();

    expect(
      document.documentElement.style.getPropertyValue(progressVariable),
    ).toBe("1");
    expect(view.container.querySelector(".will-change-transform")).toBeTruthy();
  });

  it("does not reset underline progress when optimistic selection updates mid-drag", () => {
    const view = render(
      <SwipeViews tabSetId="optimistic" activeValue="first" options={OPTIONS}>
        <div>first panel content</div>
        <div>second panel content</div>
      </SwipeViews>,
    );

    embla.listeners.get("pointerDown")?.();
    embla.scrollProgress = 0.48;
    embla.listeners.get("scroll")?.();
    embla.selectedIndex = 1;
    embla.listeners.get("select")?.();

    view.rerender(
      <SwipeViews tabSetId="optimistic" activeValue="second" options={OPTIONS}>
        <div>first panel content</div>
        <div>second panel content</div>
      </SwipeViews>,
    );

    expect(
      document.documentElement.style.getPropertyValue(
        "--top-shell-tab-swipe-optimistic-position",
      ),
    ).toBe("0.48");
  });

  it("keeps inset panel content and shadows inside the page gutter", () => {
    const view = render(
      <SwipeViews
        tabSetId="inset"
        activeValue="first"
        options={OPTIONS}
        panelInset="page"
      >
        <div>first panel content</div>
        <div>second panel content</div>
      </SwipeViews>,
    );

    const firstPanel = view.container.querySelector(
      "#top-shell-inset-panel-first",
    );
    expect(firstPanel).toHaveAttribute("data-swipe-panel-inset", "page");
    expect(firstPanel).toHaveClass("px-[var(--page-inline-gutter-standard)]");
    expect(firstPanel).toHaveClass("min-w-0", "max-w-full");
  });

  it("lets a nested pager own its horizontal drag", () => {
    render(
      <SwipeViews tabSetId="nested" activeValue="first" options={OPTIONS}>
        <div>first panel content</div>
        <div>second panel content</div>
      </SwipeViews>,
    );

    const outerRoot = document.createElement("div");
    outerRoot.dataset.swipeViewsRoot = "true";
    const nestedRoot = document.createElement("div");
    nestedRoot.dataset.swipeViewsRoot = "true";
    const nestedTarget = document.createElement("button");
    nestedRoot.append(nestedTarget);
    outerRoot.append(nestedRoot);

    const watchDrag = embla.options?.watchDrag as (
      api: Pick<EmblaCarouselType, "rootNode">,
      event: Event,
    ) => boolean;

    expect(
      watchDrag({ rootNode: () => outerRoot }, { target: nestedTarget } as Event),
    ).toBe(false);
    expect(
      watchDrag({ rootNode: () => nestedRoot }, { target: nestedTarget } as Event),
    ).toBe(true);
  });

  describe("viewport resize", () => {
    // The engine measures width once. When the container narrows without the
    // window changing — a vertical scrollbar appearing as pane content streams
    // in — a window-only listener never fires, Embla keeps a stale width, and
    // it translates by the wrong distance, leaving the previous pane clipped
    // beside the selected one (the Memory /one/pkm report).
    let observerCallback: ResizeObserverCallback | null = null;
    let observed: Element | null = null;
    let disconnected = false;
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalRaf = globalThis.requestAnimationFrame;

    beforeEach(() => {
      observerCallback = null;
      observed = null;
      disconnected = false;
      globalThis.ResizeObserver = class {
        constructor(callback: ResizeObserverCallback) {
          observerCallback = callback;
        }
        observe(element: Element) {
          observed = element;
        }
        disconnect() {
          disconnected = true;
        }
        unobserve() {}
      } as unknown as typeof ResizeObserver;
      // Run rAF work synchronously so the debounce is deterministic.
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }) as typeof globalThis.requestAnimationFrame;
    });

    afterEach(() => {
      globalThis.ResizeObserver = originalResizeObserver;
      globalThis.requestAnimationFrame = originalRaf;
    });

    const emitWidth = (width: number) => {
      observerCallback?.(
        [{ contentRect: { width } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    };

    const renderPager = () =>
      render(
        <SwipeViews tabSetId="resize" activeValue="first" options={OPTIONS}>
          <div>first panel content</div>
          <div>second panel content</div>
        </SwipeViews>,
      );

    it("observes the viewport element, not just the window", () => {
      renderPager();
      expect(observed).toBe(embla.rootNode);
    });

    it("re-initialises when the container width changes with no window resize", () => {
      vi.spyOn(embla.rootNode!, "getBoundingClientRect").mockReturnValue({
        width: 800,
      } as DOMRect);
      renderPager();
      embla.reInit.mockClear();

      emitWidth(785); // scrollbar appears; window.innerWidth never changes

      expect(embla.reInit).toHaveBeenCalledTimes(1);
    });

    it("ignores height-only changes so streaming content does not re-init", () => {
      vi.spyOn(embla.rootNode!, "getBoundingClientRect").mockReturnValue({
        width: 800,
      } as DOMRect);
      renderPager();
      embla.reInit.mockClear();

      emitWidth(800); // taller content, identical width

      expect(embla.reInit).not.toHaveBeenCalled();
    });

    it("disconnects the observer on unmount", () => {
      const view = renderPager();
      view.unmount();
      expect(disconnected).toBe(true);
    });
  });
});

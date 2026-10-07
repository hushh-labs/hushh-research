// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VirtualContactList } from "@/components/one-location/redesign/contact-picker/virtual-list";
import { CONTACT_LIST_CONTROLS_THRESHOLD } from "@/lib/one-location/contact-picker-controls";

/**
 * jsdom gives every element a zero-sized box, so a windowing virtualizer sees
 * a viewport it can fit nothing in and renders no rows at all. That is a
 * property of the test environment, not of the component -- but it means the
 * virtualized branch is invisible to a plain render, which is exactly how a
 * broken one would ship unnoticed.
 *
 * So the scroll container is given a real height here, the way the browser
 * gives it one from `max-h-[52vh]`, and the window is asserted against it.
 */
function withMeasuredViewport(heightPx: number) {
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function measured(this: HTMLElement) {
      const height = this.dataset.virtualized === "true" || this.dataset.appScrollRoot === "true" ? heightPx : 58;
      const root = this.parentElement?.closest<HTMLElement>('[data-app-scroll-root="true"]');
      const top = this.dataset.virtualized === "true" && root ? 120 - root.scrollTop : 0;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 320,
        bottom: top + height,
        width: 320,
        height,
        toJSON: () => ({}),
      } as DOMRect;
    });
  const clientHeight = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockReturnValue(heightPx);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function measured(this: HTMLElement) {
      return this.dataset.virtualized === "true" || this.dataset.appScrollRoot === "true"
        ? heightPx
        : 58;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
  return () => {
    rect.mockRestore();
    clientHeight.mockRestore();
  };
}

afterEach(() => vi.restoreAllMocks());

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: String(index) }));

function renderList(count: number) {
  return render(
    <VirtualContactList
      items={rows(count)}
      getKey={(row) => row.id}
      testId="probe-list"
      ariaLabel="Probe"
      renderItem={(row) => <div data-testid="probe-row">row {row.id}</div>}
    />,
  );
}

describe("VirtualContactList", () => {
  it("preserves page scroll when mounting and filtering across the windowing threshold", () => {
    withMeasuredViewport(400);
    const scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
      if (typeof options === "object") this.scrollTop = options.top ?? this.scrollTop;
    });
    const rootRef = (node: HTMLDivElement | null) => {
      if (node) {
        node.scrollTop = 1000;
        node.scrollTo = scrollTo;
      }
    };
    const content = (count: number) => (
      <div data-app-scroll-root="true" data-testid="retained-root" ref={rootRef}>
        <VirtualContactList
          items={rows(count)} getKey={(row) => row.id} scrollMode="page"
          testId="retained-list" ariaLabel="People"
          renderItem={(row) => <div data-testid="retained-row">person {row.id}</div>}
        />
      </div>
    );
    const view = render(content(120));
    const root = screen.getByTestId("retained-root");
    expect(root.scrollTop).toBe(1000);
    expect(screen.getAllByTestId("retained-row").length).toBeLessThan(30);
    view.rerender(content(3));
    expect(screen.getAllByTestId("retained-row")).toHaveLength(3);
    view.rerender(content(120));
    expect(root.scrollTop).toBe(1000);
    expect(screen.getAllByTestId("retained-row").length).toBeLessThan(30);
    expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it("windows page-owned contacts against the app scroll root and follows its scroll", () => {
    withMeasuredViewport(400);
    const view = render(
      <div data-app-scroll-root="true" data-testid="page-scroll">
        <VirtualContactList
          items={rows(120)}
          getKey={(row) => row.id}
          testId="page-list"
          ariaLabel="People"
          scrollMode="page"
          renderItem={(row) => <button data-testid="page-row">person {row.id}</button>}
        />
        <button>Continue</button>
      </div>,
    );
    const list = screen.getByTestId("page-list");
    expect(list.className).not.toContain("overflow-y-auto");
    expect(list.className).not.toContain("max-h-");
    expect(screen.getAllByTestId("page-row").length).toBeLessThan(30);
    const before = screen.getAllByTestId("page-row").map((row) => row.textContent);
    const root = screen.getByTestId("page-scroll");
    act(() => {
      root.scrollTop = 2500;
      fireEvent.scroll(root);
    });
    const after = screen.getAllByTestId("page-row").map((row) => row.textContent);
    expect(after).not.toEqual(before);
    expect(after.length).toBeLessThan(30);
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    view.unmount();
  });

  it("renders a short list as plain rows, with no windowing at all", () => {
    renderList(CONTACT_LIST_CONTROLS_THRESHOLD);

    const list = screen.getByTestId("probe-list");
    expect(list).not.toHaveAttribute("data-virtualized");
    // Every row present: a virtualizer measuring ten rows costs more than it
    // saves, and keeping them plain is what leaves small fixtures directly
    // assertable in every other test in this feature.
    expect(screen.getAllByTestId("probe-row")).toHaveLength(
      CONTACT_LIST_CONTROLS_THRESHOLD,
    );
  });

  it("windows a long roster instead of mounting all of it", () => {
    const restore = withMeasuredViewport(400);
    try {
      renderList(120);

      const list = screen.getByTestId("probe-list");
      expect(list).toHaveAttribute("data-virtualized", "true");

      // The scalability claim, stated as a bound rather than a feeling: a
      // 120-person Circle must not put 120 rows in the document.
      const mounted = screen.queryAllByTestId("probe-row");
      expect(mounted.length).toBeGreaterThan(0);
      expect(mounted.length).toBeLessThan(30);

      // ...while the scroller still reserves the full height, so the scrollbar
      // tells the truth about how much list there is. The two together are
      // what "windowed" means, and together they fail loudly if this ever
      // regresses to rendering the whole roster.
      const sizer = list.firstElementChild as HTMLElement;
      expect(parseInt(sizer.style.height, 10)).toBeGreaterThanOrEqual(120 * 58);

    } finally {
      restore();
    }
  });

  it("keeps its own scroll surface bounded so the page does not nest scrollers", () => {
    const restore = withMeasuredViewport(400);
    try {
      renderList(120);
      const list = screen.getByTestId("probe-list");
      expect(list.className).toContain("overflow-y-auto");
      expect(list.className).toContain("max-h-[52vh]");
    } finally {
      restore();
    }
  });

  it("preserves row sizes through transient zero measurements and accepts real resizing", () => {
    withMeasuredViewport(400);
    const observers: Array<{
      callback: ResizeObserverCallback;
      targets: Set<Element>;
    }> = [];
    class MeasuredObserver {
      targets = new Set<Element>();
      constructor(public callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    }
    vi.stubGlobal("ResizeObserver", MeasuredObserver);
    const notifyRows = (height: number) =>
      act(() => {
        for (const observer of observers) {
          const entries = [...observer.targets]
            .filter((target) => target.hasAttribute("data-index"))
            .map((target) => ({
              target,
              borderBoxSize: [{ blockSize: height, inlineSize: 320 }],
            }) as unknown as ResizeObserverEntry);
          if (entries.length) {
            observer.callback(entries, observer as unknown as ResizeObserver);
          }
        }
      });
    try {
      renderList(120);
      const list = screen.getByTestId("probe-list");
      const sizer = list.firstElementChild as HTMLElement;
      const initialHeight = parseInt(sizer.style.height, 10);
      notifyRows(88);
      const expandedHeight = parseInt(sizer.style.height, 10);
      expect(expandedHeight).toBeGreaterThan(initialHeight);
      notifyRows(0);
      expect(parseInt(sizer.style.height, 10)).toBe(expandedHeight);
      notifyRows(58);
      expect(parseInt(sizer.style.height, 10)).toBeLessThan(expandedHeight);
      expect(screen.getAllByTestId("probe-row").length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["grouped", "cards"] as const)("keeps the %s scroller and focus when selection changes during scrolling", (presentation) => {
    withMeasuredViewport(400);
    const items = rows(120);
    const content = (selected: boolean) => (
      <VirtualContactList
        items={items}
        getKey={(row) => row.id}
        testId="probe-list"
        ariaLabel="Probe"
        presentation={presentation}
        renderItem={(row) => (
          <button aria-pressed={selected && row.id === "0"}>
            row {row.id}
          </button>
        )}
      />
    );
    const { rerender } = render(content(false));
    const list = screen.getByTestId("probe-list");
    const button = screen.getByRole("button", { name: "row 0" });
    button.focus();
    list.scrollTop = 232;
    fireEvent.scroll(list);
    rerender(content(true));
    expect(screen.getByTestId("probe-list")).toBe(list);
    expect(list.scrollTop).toBe(232);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-pressed", "true");
    list.scrollTop = 0;
    fireEvent.scroll(list);
    expect(screen.getByTestId("probe-list")).toBe(list);
  });
});

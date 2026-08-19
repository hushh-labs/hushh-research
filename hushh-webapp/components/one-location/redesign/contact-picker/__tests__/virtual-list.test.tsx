// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
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
      const height = this.dataset.virtualized === "true" ? heightPx : 58;
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 320,
        bottom: height,
        width: 320,
        height,
        toJSON: () => ({}),
      } as DOMRect;
    });
  const clientHeight = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockReturnValue(heightPx);
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
      expect(mounted.length).toBeLessThan(30);

      // ...while the scroller still reserves the full height, so the scrollbar
      // tells the truth about how much list there is. The two together are
      // what "windowed" means, and together they fail loudly if this ever
      // regresses to rendering the whole roster.
      const sizer = list.firstElementChild as HTMLElement;
      expect(parseInt(sizer.style.height, 10)).toBeGreaterThanOrEqual(120 * 58);

      // Deliberately NOT asserted here: that at least one row is mounted.
      // jsdom's ResizeObserver is a no-op stub (see __tests__/setup.ts), so the
      // virtualizer is never handed a viewport and computes an empty visible
      // range no matter what the element's rect claims. Proving the window is
      // non-empty needs a real layout engine, which is a browser-level layout
      // spec's job, not this file's.
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
});

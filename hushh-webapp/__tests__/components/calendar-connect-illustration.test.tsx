import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CalendarConnectIllustration } from "@/components/calendar/calendar-connect-illustration";

type FakeAnimation = { cancel: ReturnType<typeof vi.fn> };

const CARD_RECT = { left: 100, top: 100, width: 200, height: 300 };

let animate: ReturnType<typeof vi.fn>;
let animations: FakeAnimation[];
let visibility: DocumentVisibilityState;
let reducedMotion: boolean;
let reducedMotionListeners: Array<(event: { matches: boolean }) => void>;
let observers: FakeIntersectionObserver[];
const originalIntersectionObserver = globalThis.IntersectionObserver;

/** Reports visibility only when a test says so, like a real observer would. */
class FakeIntersectionObserver {
  observed: Element[] = [];
  disconnect = vi.fn(() => {
    this.observed = [];
  });
  constructor(private readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  unobserve = vi.fn();
  takeRecords = () => [];
  report(isIntersecting: boolean) {
    if (this.observed.length === 0) return;
    this.callback(
      [{ isIntersecting, target: this.observed[0] } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function intersect(isIntersecting: boolean) {
  act(() => {
    observers.forEach((observer) => observer.report(isIntersecting));
  });
}

/** Renders the illustration and reports it as on screen. */
function renderIllustration() {
  const result = render(<CalendarConnectIllustration />);
  intersect(true);
  return result;
}

function rectFor(element: Element) {
  if (element.hasAttribute("data-entrance-card")) return CARD_RECT;
  // Tiles sit at distinct places away from the card's centre (200, 250).
  const index = Array.from(
    document.querySelectorAll("[data-entrance-tile]"),
  ).indexOf(element);
  return { left: index * 40, top: index * 10, width: 20, height: 20 };
}

function mockRect(this: Element) {
  const { left, top, width, height } = rectFor(this);
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function week(container: HTMLElement) {
  const grid = container.querySelector('[data-testid="calendar-connect-week"]')!;
  const cells = Array.from(grid.children);
  const todayCell = cells.findIndex((cell) => cell.querySelector('[data-today="true"]'));
  return {
    dates: cells.map((cell) => cell.textContent?.trim()),
    todayColumn: todayCell,
    todayText: container.querySelector('[data-today="true"]')?.textContent,
    heading: container.querySelector('[data-testid="calendar-connect-month"]')?.textContent,
  };
}

function tiles(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-entrance-tile]"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 30, 12, 0, 0));
  visibility = "visible";
  reducedMotion = false;
  reducedMotionListeners = [];
  observers = [];
  globalThis.IntersectionObserver =
    FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  animations = [];
  animate = vi.fn(() => {
    const animation = { cancel: vi.fn() };
    animations.push(animation);
    return animation;
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    writable: true,
    value: animate,
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(mockRect);
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
      reducedMotionListeners.push(listener),
    removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => {
      reducedMotionListeners = reducedMotionListeners.filter((l) => l !== listener);
    },
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  globalThis.IntersectionObserver = originalIntersectionObserver;
  vi.useRealTimers();
  vi.restoreAllMocks();
  // @ts-expect-error test-only removal of the mocked API
  delete HTMLElement.prototype.animate;
  // @ts-expect-error test-only removal of the instance override
  delete document.visibilityState;
});

describe("CalendarConnectIllustration live week", () => {
  it("highlights today in its weekday column", () => {
    const { container } = renderIllustration();
    expect(week(container)).toEqual({
      dates: ["25", "26", "27", "28", "29", "30", "31"],
      todayColumn: 5,
      todayText: "30",
      heading: "October 2026",
    });
  });

  it("keeps the weekday headers fixed", () => {
    const { container } = renderIllustration();
    expect(container.textContent).toContain("SMTWTFS");
  });

  it("rolls over at local midnight while the screen stays open", () => {
    vi.setSystemTime(new Date(2026, 9, 31, 23, 59, 50));
    const { container } = renderIllustration();
    expect(week(container)).toMatchObject({ todayColumn: 6, todayText: "31", heading: "October 2026" });

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(week(container)).toEqual({
      dates: ["1", "2", "3", "4", "5", "6", "7"],
      todayColumn: 0,
      todayText: "1",
      heading: "November 2026",
    });

    // The next midnight is scheduled again, not just once. 25 hours clears
    // the next midnight even on a daylight-saving day.
    act(() => {
      vi.advanceTimersByTime(25 * 3_600_000);
    });
    expect(week(container)).toMatchObject({ todayColumn: 1, todayText: "2" });
  });

  it("moves the highlight correctly on every day of a week, day after day", () => {
    // Start Sunday 1 Nov 2026 just after midnight and let nine midnights pass
    // while the screen stays open: each day must land in its own column,
    // across a week boundary, with no skipped or repeated day.
    vi.setSystemTime(new Date(2026, 10, 1, 0, 0, 5));
    const { container } = renderIllustration();
    const seen: Array<[number, string | null | undefined]> = [];
    for (let day = 0; day < 9; day += 1) {
      const { todayColumn, todayText } = week(container);
      seen.push([todayColumn, todayText]);
      act(() => {
        // Step to just past the next local midnight (computed from the local calendar, so DST days are exact).
        const now = new Date();
        const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
        vi.advanceTimersByTime(nextMidnight.getTime() - now.getTime());
      });
    }
    expect(seen).toEqual([
      [0, "1"], [1, "2"], [2, "3"], [3, "4"], [4, "5"], [5, "6"], [6, "7"],
      [0, "8"], [1, "9"],
    ]);
    expect(week(container).dates).toEqual(["8", "9", "10", "11", "12", "13", "14"]);
  });

  it("recomputes from the clock after the page returns from the background", () => {
    const { container } = renderIllustration();
    // The device slept for several days without any timer firing.
    vi.setSystemTime(new Date(2027, 0, 1, 8, 0, 0));
    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(week(container)).toEqual({
      dates: ["27", "28", "29", "30", "31", "1", "2"],
      todayColumn: 5,
      todayText: "1",
      heading: "January 2027",
    });
  });

  it.each([
    ["focus", () => window.dispatchEvent(new Event("focus"))],
    ["pageshow", () => window.dispatchEvent(new Event("pageshow"))],
  ])("re-reads the clock on %s", (_name, fire) => {
    const { container } = renderIllustration();
    vi.setSystemTime(new Date(2026, 10, 2, 8, 0, 0));
    act(() => {
      fire();
    });
    expect(week(container)).toMatchObject({ todayColumn: 1, todayText: "2", heading: "November 2026" });
  });

  it("ignores a hidden-page event without re-reading the clock", () => {
    const { container } = renderIllustration();
    vi.setSystemTime(new Date(2026, 10, 2, 8, 0, 0));
    act(() => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(week(container)).toMatchObject({ todayText: "30" });
  });

  it("removes its timers and listeners when the screen is removed", () => {
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderIllustration();
    unmount();
    expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith("pageshow", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("CalendarConnectIllustration opening animation", () => {
  it("starts four staggered animations from behind the card", () => {
    const { container } = renderIllustration();
    expect(animate).toHaveBeenCalledTimes(4);

    const options = animate.mock.calls.map((call) => call[1]);
    expect(options.map((o) => o.delay)).toEqual([0, 50, 100, 150]);
    for (const option of options) {
      expect(option).toMatchObject({ duration: 700, fill: "backwards" });
      expect(option.easing).toMatch(/^cubic-bezier/);
    }

    // Each tile starts translated onto the card's centre (200, 250).
    animate.mock.calls.forEach(([keyframes], index) => {
      const left = index * 40 + 10;
      const top = index * 10 + 10;
      expect(keyframes[0].transform).toBe(
        `translate(${200 - left}px, ${250 - top}px) scale(0.85)`,
      );
      expect(keyframes[1].transform).toBe("translate(0px, 0px) scale(1)");
    });

    // The wrappers are shown once the animations hold them behind the card.
    for (const tile of tiles(container)) {
      expect(tile.hasAttribute("data-entrance")).toBe(false);
    }
  });

  it("moves wrappers only, leaving each tile's own rotation alone", () => {
    const { container } = renderIllustration();
    const wrappers = tiles(container);
    expect(wrappers).toHaveLength(4);
    expect(animate.mock.instances).toEqual(wrappers);
    const rotations = wrappers.map((wrapper) =>
      /rotate-\[(-?\d+)deg\]/.exec(wrapper.firstElementChild!.className)?.[1],
    );
    expect(rotations).toEqual(["-10", "-8", "10", "9"]);
    for (const wrapper of wrappers) {
      expect(wrapper.className).not.toContain("rotate-");
    }
  });

  it("keeps the card above the tiles inside its own stacking context", () => {
    const { container } = renderIllustration();
    const card = container.querySelector("[data-entrance-card]")!;
    expect(card.className).toContain("z-20");
    for (const tile of tiles(container)) expect(tile.className).toContain("z-10");
    expect(card.closest(".isolate")).not.toBeNull();
  });

  it("plays once: date refreshes and re-renders never replay it", () => {
    vi.setSystemTime(new Date(2026, 9, 31, 23, 59, 50));
    const { container, rerender } = renderIllustration();
    const before = tiles(container);
    expect(animate).toHaveBeenCalledTimes(4);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    rerender(<CalendarConnectIllustration />);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("resize"));
    });

    expect(week(container).todayText).toBe("1");
    expect(animate).toHaveBeenCalledTimes(4);
    // The very same elements: the illustration was not remounted.
    tiles(container).forEach((tile, index) => expect(tile).toBe(before[index]));
  });

  it("waits until the illustration is in view, then plays once", () => {
    const { container } = render(<CalendarConnectIllustration />);
    expect(animate).not.toHaveBeenCalled();
    for (const tile of tiles(container)) {
      expect(tile.getAttribute("data-entrance")).toBe("pending");
    }

    intersect(false);
    expect(animate).not.toHaveBeenCalled();

    intersect(true);
    expect(animate).toHaveBeenCalledTimes(4);
    for (const tile of tiles(container)) expect(tile.hasAttribute("data-entrance")).toBe(false);

    // Scrolling away and back does not replay it.
    intersect(false);
    intersect(true);
    expect(animate).toHaveBeenCalledTimes(4);
  });

  it("waits while the page is hidden, then plays once when it becomes visible", () => {
    visibility = "hidden";
    const { container } = renderIllustration();
    expect(animate).not.toHaveBeenCalled();
    for (const tile of tiles(container)) {
      expect(tile.getAttribute("data-entrance")).toBe("pending");
    }

    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(animate).toHaveBeenCalledTimes(4);
    for (const tile of tiles(container)) expect(tile.hasAttribute("data-entrance")).toBe(false);

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(animate).toHaveBeenCalledTimes(4);
  });

  it("shows the final arrangement immediately for reduced motion", () => {
    reducedMotion = true;
    const { container } = renderIllustration();
    expect(animate).not.toHaveBeenCalled();
    for (const tile of tiles(container)) expect(tile.hasAttribute("data-entrance")).toBe(false);
    // The live date still works.
    expect(week(container).todayText).toBe("30");
  });

  it("cancels the animation and reveals the tiles when reduced motion turns on", () => {
    visibility = "hidden";
    const { container } = renderIllustration();
    act(() => {
      reducedMotionListeners.forEach((listener) => listener({ matches: true }));
    });
    for (const tile of tiles(container)) expect(tile.hasAttribute("data-entrance")).toBe(false);

    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(animate).not.toHaveBeenCalled();
  });

  it("cancels running animations on unmount", () => {
    const { unmount } = renderIllustration();
    unmount();
    expect(animations).toHaveLength(4);
    for (const animation of animations) expect(animation.cancel).toHaveBeenCalled();
  });

  it("shows the final arrangement where the Web Animations API is missing", () => {
    // @ts-expect-error test-only removal of the mocked API
    delete HTMLElement.prototype.animate;
    const { container } = renderIllustration();
    for (const tile of tiles(container)) expect(tile.hasAttribute("data-entrance")).toBe(false);
  });
});

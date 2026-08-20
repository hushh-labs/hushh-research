/** @vitest-environment jsdom */

/**
 * The Menu / People / Links transition on the One Location hub, and the shared
 * pager and tab strip it is built from.
 *
 * Every assertion here was written against a defect measured frame by frame in
 * a real browser at 390x844, on `origin/main`, before it was fixed:
 *
 *  - the viewport height snapped to the incoming panel one frame after the tap,
 *    while the outgoing one was still 89% on screen: 1400px -> 520px at t=99ms
 *    with the leaving panel at x=-43, clipping 880px of content the person was
 *    still looking at;
 *  - the strip wrote the destination once and eased it over 240ms while the
 *    pager overwrote the same CSS variable with live scroll progress on every
 *    frame of that transition, so the panel landed at ~400ms and the pill was
 *    still creeping at ~600ms;
 *  - with Reduce Motion on, the pill jumped to the destination and then snapped
 *    backwards (indicator x: 16 -> 135 -> 29 -> ... -> 135) and the panel still
 *    travelled a full screen width;
 *  - panels that were off screen and marked `aria-hidden` were still in the tab
 *    order, so the keyboard walked into content the person could not see.
 *
 * These are behavioural contracts, not pixels. The pixel evidence lives in the
 * browser measurements above; what is locked here is the logic that produced
 * it, so a future edit cannot quietly restore any of the four.
 */

import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import { TopShellTabs } from "@/components/app-ui/top-shell-tabs";
import type { TopShellTabSet } from "@/lib/navigation/top-shell-tabs";
import {
  hasTopShellTabPager,
  requestTopShellTabSelection,
  setTopShellTabSwipeState,
  useTopShellTabSwipeState,
} from "@/lib/navigation/top-shell-tab-swipe-progress";

const SLIDE_WIDTH = 390;

/**
 * A fake Embla that models POSITION, not just a selected index.
 *
 * The behaviours under test are all about where the panes actually are
 * mid-transition, so a mock that only remembers "index 1" cannot express them.
 */
const embla = vi.hoisted(() => ({
  offset: 0,
  target: 0,
  slideCount: 3,
  scrollTo: vi.fn<(index: number, jump?: boolean) => void>(),
  reInit: vi.fn(),
  listeners: new Map<string, () => void>(),
  ref: vi.fn(),
  root: null as HTMLElement | null,
  container: null as HTMLElement | null,
  options: null as Record<string, unknown> | null,
}));

vi.mock("embla-carousel-react", () => ({
  default: (options: Record<string, unknown>) => {
    embla.options = options;
    const engine = {
      slideRects: Array.from({ length: embla.slideCount }, () => ({
        width: SLIDE_WIDTH,
      })),
      scrollSnaps: Array.from(
        { length: embla.slideCount },
        (_unused, index) => -(index * SLIDE_WIDTH),
      ),
      containerRect: { width: SLIDE_WIDTH },
      scrollBounds: { toggleActive: vi.fn() },
      animation: { start: vi.fn() },
      target: { set: (value: number) => (embla.target = value), get: () => embla.target },
      location: { set: (value: number) => (embla.offset = value) },
      offsetLocation: {
        set: (value: number) => (embla.offset = value),
        get: () => embla.offset,
      },
      previousLocation: { set: () => undefined },
      translate: { to: () => undefined },
    };
    return [
      embla.ref,
      {
        selectedScrollSnap: () => Math.round(-embla.offset / SLIDE_WIDTH),
        // Derived from position, exactly as Embla derives it. A mock that
        // stored progress separately let the two disagree, which is a state
        // the real engine cannot be in.
        scrollProgress: () =>
          -embla.offset / ((embla.slideCount - 1) * SLIDE_WIDTH),
        scrollTo: embla.scrollTo,
        reInit: embla.reInit,
        internalEngine: () => engine,
        containerNode: () => embla.container ?? document.body,
        rootNode: () => embla.root ?? document.body,
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

const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
}));
vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({
  useInteractionIntents: () => [],
}));
vi.mock("@/lib/morphy-ux/hooks/use-route-transition", () => ({
  beginRouteTransition: (_href: string, navigate: () => void) => navigate(),
}));

const OPTIONS = [
  { value: "now", label: "Menu" },
  { value: "people", label: "People" },
  { value: "links", label: "Links" },
] as const;

const PANEL_HEIGHTS: Record<string, number> = {
  "top-shell-location-panel-now": 1400,
  "top-shell-location-panel-people": 520,
  "top-shell-location-panel-links": 240,
};

const LOCATION_TAB_SET: TopShellTabSet = {
  id: "location",
  label: "Location",
  queryParam: "view",
  activeValue: "now",
  tabs: [
    { value: "now", label: "Menu", href: "/one/location" },
    { value: "people", label: "People", href: "/one/location?view=people" },
    { value: "links", label: "Links", href: "/one/location?view=links" },
  ],
};

let reduceMotion = false;
let scrollHeightDescriptor: PropertyDescriptor | undefined;

/** Places the pager at a fractional index and fires the frame handler. */
function scrollTo(position: number) {
  act(() => {
    embla.offset = -position * SLIDE_WIDTH;
    embla.listeners.get("scroll")?.();
  });
}

/** Fires one of Embla's own events and flushes the React work it causes. */
function emblaEvent(name: string, before?: () => void) {
  act(() => {
    before?.();
    embla.listeners.get(name)?.();
  });
}

/** Presses a shell tab the way the top bar does, through the shared channel. */
function pressTab(value: string) {
  act(() => {
    requestTopShellTabSelection("location", value);
  });
}

/**
 * The shared position variable is written to the tab strip element when one is
 * mounted, and only falls back to <html> when none is -- that scoping is what
 * keeps a drag from invalidating styles for the whole app every frame.
 */
function swipeVariable(tabSetId: string): string {
  const owner =
    document.querySelector<HTMLElement>(
      `[data-top-shell-tab-set="${tabSetId}"]`,
    ) ?? document.documentElement;
  return owner.style.getPropertyValue(
    `--top-shell-tab-swipe-${tabSetId}-position`,
  );
}

/**
 * The pager as every real consumer wires it: the value it reports becomes the
 * value it is given back. A fixture that never adopts the reported selection
 * models a consumer that refused it, which is a different contract.
 */
function ControlledLocationPager({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  return <LocationPager activeValue={value} onSelectionChange={setValue} />;
}

/**
 * Records every write to a shared tab-position variable, in order.
 *
 * The defect being guarded is a SEQUENCE, not an end state: the strip wrote the
 * destination index and the pager then corrected it to the pane's real position
 * in the same tick. Reading the variable afterwards shows the corrected value
 * either way, so only the ordering can tell the two apart -- and the ordering is
 * exactly what the browser sees as a 240ms transition being restarted on every
 * frame of the movement it is supposed to be showing.
 */
function recordSwipeWrites(): { values: string[]; restore: () => void } {
  const values: string[] = [];
  const original = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function setProperty(
    this: CSSStyleDeclaration,
    name: string,
    value: string | null,
    priority?: string,
  ) {
    if (name.startsWith("--top-shell-tab-swipe")) values.push(String(value));
    return original.call(this, name, value as string, priority);
  };
  return {
    values,
    restore: () => {
      CSSStyleDeclaration.prototype.setProperty = original;
    },
  };
}

function pagerRoot(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-swipe-views-root="true"]')!;
}

function panels(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
}

function LocationPager({
  activeValue,
  onSelectionChange,
  onSelectionCommit,
}: {
  activeValue: string;
  onSelectionChange?: (value: string) => void;
  onSelectionCommit?: (value: string) => void;
}) {
  return (
    <SwipeViews
      tabSetId="location"
      activeValue={activeValue}
      options={OPTIONS}
      onSelectionChange={onSelectionChange}
      onSelectionCommit={onSelectionCommit}
      viewportMinHeight="0px"
      heightMode="active"
    >
      <div>Menu panel</div>
      <div>People panel</div>
      <div>Links panel</div>
    </SwipeViews>
  );
}

beforeEach(() => {
  embla.offset = 0;
  embla.target = 0;
  embla.slideCount = 3;
  embla.scrollTo.mockClear();
  embla.reInit.mockClear();
  embla.listeners.clear();
  embla.root = document.createElement("div");
  embla.root.getBoundingClientRect = () =>
    ({ width: SLIDE_WIDTH, height: 800 }) as DOMRect;
  // The self-healing pass compares the container's real child count against
  // the engine's snap count, so the container has to actually hold the slides
  // or every render looks like a stale carousel needing repair.
  embla.container = document.createElement("div");
  for (let index = 0; index < embla.slideCount; index += 1) {
    embla.container.appendChild(document.createElement("div"));
  }
  embla.options = null;
  navigation.replace.mockClear();
  navigation.push.mockClear();
  reduceMotion = false;

  document.documentElement.removeAttribute("style");
  for (const id of ["location", "ria"]) setTopShellTabSwipeState(id, 0, false);

  // The measurement path is `scrollHeight` on the panel node, which jsdom
  // always reports as 0. Resolve it from the panel's own id instead so the
  // three panes have the different heights this contract is about.
  scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return PANEL_HEIGHTS[this.id] ?? 0;
    },
  });

  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reduceMotion : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }));
  // Run measurement frames inline so a rerender's height is observable in the
  // same tick. Nothing under test depends on real frame scheduling.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  if (scrollHeightDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollHeight",
      scrollHeightDescriptor,
    );
  }
  vi.unstubAllGlobals();
});

describe("Location tab transition — panels the person cannot see", () => {
  it("takes off-screen panels out of the tab order, not just out of the accessibility tree", () => {
    const { container } = render(<LocationPager activeValue="people" />);
    const [menu, people, links] = panels(container);

    expect(people).not.toHaveAttribute("inert");
    expect(people).toHaveAttribute("aria-hidden", "false");

    // `aria-hidden` on its own left every button and link inside these panes
    // focusable, which is both a WCAG violation and a panel the person cannot
    // see taking a press.
    expect(menu).toHaveAttribute("inert");
    expect(links).toHaveAttribute("inert");
    expect(menu).toHaveAttribute("aria-hidden", "true");
    expect(links).toHaveAttribute("aria-hidden", "true");
    expect(menu).toHaveAttribute("tabindex", "-1");
  });
});

describe("Location tab transition — the viewport never clips a leaving panel", () => {
  it("holds the taller height until the outgoing panel is off screen, then comes down", () => {
    const view = render(<LocationPager activeValue="now" />);
    const root = pagerRoot(view.container);
    expect(root.style.height).toBe("1400px");

    // The selection flips at the START of the motion, not the end.
    act(() => {
      view.rerender(<LocationPager activeValue="people" />);
    });
    expect(root.style.height).toBe("1400px");

    // Most of the way there, with the outgoing panel still partly on screen.
    scrollTo(0.9);
    expect(root.style.height).toBe("1400px");
    expect(root).not.toHaveAttribute("data-swipe-views-height-settling");

    // Arrived: the outgoing panel has left, so the box may now come down --
    // and only now does it get a transition, because growing has to be
    // instant or the INCOMING panel is the one that gets clipped.
    scrollTo(1);
    expect(root.style.height).toBe("520px");
    expect(root).toHaveAttribute("data-swipe-views-height-settling", "true");
    expect(root.className).toContain("transition-[height]");
    expect(root.className).toContain("motion-reduce:transition-none");
  });

  it("grows immediately when the incoming panel is the taller one", () => {
    const view = render(<LocationPager activeValue="links" />);
    const root = pagerRoot(view.container);
    embla.offset = -2 * SLIDE_WIDTH;
    expect(root.style.height).toBe("240px");

    act(() => {
      view.rerender(<LocationPager activeValue="now" />);
    });
    expect(root.style.height).toBe("1400px");
  });

  it("never lets a settling height transition survive into the next switch", () => {
    const view = render(<LocationPager activeValue="now" />);
    const root = pagerRoot(view.container);

    act(() => {
      view.rerender(<LocationPager activeValue="people" />);
    });
    scrollTo(1);
    expect(root).toHaveAttribute("data-swipe-views-height-settling", "true");

    act(() => {
      view.rerender(<LocationPager activeValue="links" />);
    });
    expect(root).not.toHaveAttribute("data-swipe-views-height-settling");
    expect(root.style.height).toBe("520px");
  });
});

describe("Location tab transition — one writer owns the indicator", () => {
  function OwnershipProbe() {
    const state = useTopShellTabSwipeState("location");
    return (
      <span data-testid="owner">{`${state.pagerOwned}:${state.position}`}</span>
    );
  }

  it("claims the shared position for the whole flight and hands it back on settle", () => {
    render(
      <>
        <ControlledLocationPager initialValue="now" />
        <OwnershipProbe />
      </>,
    );

    expect(screen.getByTestId("owner")).toHaveTextContent("false:0");

    pressTab("people");
    expect(embla.scrollTo).toHaveBeenCalledWith(1);
    // Owned from the first frame, so the strip cannot start a second,
    // differently-timed animation of the same movement against it.
    expect(screen.getByTestId("owner")).toHaveTextContent("true:");

    scrollTo(0.5);
    expect(swipeVariable("location")).toBe("0.5");

    emblaEvent("settle", () => {
      embla.offset = -SLIDE_WIDTH;
    });
    expect(screen.getByTestId("owner")).toHaveTextContent("false:1");
  });

  it("hands ownership to a finger that lands mid-flight", () => {
    render(
      <>
        <ControlledLocationPager initialValue="now" />
        <OwnershipProbe />
      </>,
    );

    pressTab("people");
    emblaEvent("pointerDown");
    scrollTo(0.3);
    expect(screen.getByTestId("owner")).toHaveTextContent("true:");

    emblaEvent("settle", () => {
      embla.offset = -SLIDE_WIDTH;
    });
    expect(screen.getByTestId("owner")).toHaveTextContent("false:1");
  });
});

describe("Location tab transition — Reduce Motion", () => {
  it("places the panel instead of travelling a full screen width", () => {
    reduceMotion = true;
    render(<LocationPager activeValue="now" />);

    pressTab("people");

    expect(embla.scrollTo).toHaveBeenCalledWith(1, true);
    expect(swipeVariable("location")).toBe("1");
  });

  it("still reports the selection, because a jump emits no select or settle", async () => {
    reduceMotion = true;
    const onSelectionChange = vi.fn();
    const onSelectionCommit = vi.fn();
    render(
      <LocationPager
        activeValue="now"
        onSelectionChange={onSelectionChange}
        onSelectionCommit={onSelectionCommit}
      />,
    );

    pressTab("people");

    // Reported one frame later, where Embla's own `select` would have landed.
    // Reporting inside the tap's own dispatch put a second navigation request
    // ahead of the strip's in the same tick, and the tap then produced no
    // history write at all.
    expect(onSelectionChange).toHaveBeenCalledWith("people");
    expect(onSelectionCommit).toHaveBeenCalledWith("people");
  });

  it("does not drag the panel back before the consumer's value catches up", () => {
    reduceMotion = true;
    const view = render(<LocationPager activeValue="now" />);

    pressTab("people");
    expect(embla.scrollTo).toHaveBeenLastCalledWith(1, true);
    embla.scrollTo.mockClear();

    // The route has not committed yet, so the pager still receives "now".
    // Repairing that disagreement here would undo the person's own tap.
    act(() => {
      view.rerender(<LocationPager activeValue="now" />);
    });
    // It may re-assert where it already is; it must never go back to the tab
    // the person just left.
    for (const call of embla.scrollTo.mock.calls) expect(call[0]).toBe(1);
    embla.scrollTo.mockClear();

    // A value that is neither where we were nor where we went still wins.
    act(() => {
      view.rerender(<LocationPager activeValue="links" />);
    });
    expect(embla.scrollTo).toHaveBeenCalledWith(2, true);
  });
});

describe("Location tab strip", () => {
  it("does not write the shared position itself when a pager owns it", () => {
    const { unmount } = render(<LocationPager activeValue="now" />);
    expect(hasTopShellTabPager("location")).toBe(true);

    render(<TopShellTabs tabSet={LOCATION_TAB_SET} />);
    act(() => {
      setTopShellTabSwipeState("location", 0, false);
    });

    const recorder = recordSwipeWrites();
    act(() => {
      screen.getByRole("tab", { name: "People" }).click();
    });
    recorder.restore();

    // The pager moved it...
    expect(embla.scrollTo).toHaveBeenCalledWith(1);

    // ...and at no point in that tick did anything write the DESTINATION index
    // to the shared variable. Every write is the pane's real position, which
    // has not moved yet.
    expect(recorder.values.length).toBeGreaterThan(0);
    expect(recorder.values.every((value) => value === "0")).toBe(true);
    expect(swipeVariable("location")).toBe("0");

    unmount();
    expect(hasTopShellTabPager("location")).toBe(false);
  });

  it("keeps its own transition for a tab set with no pager", () => {
    const routeTabs: TopShellTabSet = {
      ...LOCATION_TAB_SET,
      id: "ria",
      queryParam: null,
    };
    render(<TopShellTabs tabSet={routeTabs} />);
    expect(hasTopShellTabPager("ria")).toBe(false);

    act(() => {
      screen.getByRole("tab", { name: "People" }).click();
    });

    expect(swipeVariable("ria")).toBe("1");
  });

  it("drops its transition while the pager owns the position", () => {
    const view = render(<TopShellTabs tabSet={LOCATION_TAB_SET} />);
    const indicator = () =>
      view.container.querySelector<HTMLElement>(
        '[data-testid="top-shell-tab-indicator"]',
      )!;

    expect(indicator().className).toContain("transition-transform");

    act(() => {
      setTopShellTabSwipeState("location", 0.4, true);
    });
    expect(indicator().className).toContain("transition-none");
    expect(indicator().className).not.toContain("transition-transform");

    act(() => {
      setTopShellTabSwipeState("location", 1, false);
    });
    expect(indicator().className).toContain("transition-transform");
  });
});

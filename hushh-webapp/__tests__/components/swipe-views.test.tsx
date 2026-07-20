/** @vitest-environment jsdom */

import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SwipeViews } from "@/components/app-ui/swipe-views";

const embla = vi.hoisted(() => ({
  selectedIndex: 0,
  scrollProgress: 0,
  scrollTo: vi.fn<(index: number) => void>(),
  listeners: new Map<string, () => void>(),
  ref: vi.fn(),
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
    embla.listeners.clear();
    embla.options = null;
  });

  it("mounts only the route-selected panel and keeps semantic panel targets", () => {
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
    expect(screen.queryByText("second panel content")).not.toBeInTheDocument();
    expect(mounts).toEqual({ first: 1, second: 0 });
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

    expect(screen.queryByText("first panel content")).not.toBeInTheDocument();
    expect(screen.getByText("second panel content")).toBeInTheDocument();
    expect(mounts).toEqual({ first: 1, second: 1 });
    expect(cleanups).toEqual({ first: 1, second: 0 });
    expect(embla.scrollTo).toHaveBeenCalledWith(1);
    expect(
      screen
        .getByText("second panel content")
        .closest("[data-morphy-enter='true']"),
    ).toBeNull();
  });

  it("reports the destination as soon as a horizontal pager selects it", () => {
    const onSelectionChange = vi.fn();

    render(
      <SwipeViews
        tabSetId="demo"
        activeValue="first"
        options={OPTIONS}
        onSelectionChange={onSelectionChange}
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
    expect(embla.options).toMatchObject({ duration: 20 });
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
    expect(document.documentElement.style.getPropertyValue(progressVariable)).toBe(
      "0.45",
    );

    embla.selectedIndex = 1;
    embla.scrollProgress = 1;
    embla.listeners.get("settle")?.();

    expect(document.documentElement.style.getPropertyValue(progressVariable)).toBe(
      "1",
    );
    expect(view.container.querySelector(".will-change-transform")).toBeTruthy();
  });
});

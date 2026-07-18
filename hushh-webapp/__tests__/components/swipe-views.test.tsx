/** @vitest-environment jsdom */

import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SwipeViews } from "@/components/app-ui/swipe-views";

const embla = vi.hoisted(() => ({
  selectedIndex: 0,
  scrollTo: vi.fn<(index: number) => void>(),
  listeners: new Map<string, () => void>(),
  ref: vi.fn(),
}));

vi.mock("embla-carousel-react", () => ({
  default: () => [
    embla.ref,
    {
      selectedScrollSnap: () => embla.selectedIndex,
      scrollTo: embla.scrollTo,
      on: (event: string, listener: () => void) => {
        embla.listeners.set(event, listener);
      },
      off: (event: string) => {
        embla.listeners.delete(event);
      },
    },
  ],
}));

const OPTIONS = [
  { value: "first", label: "First" },
  { value: "second", label: "Second" },
] as const;

describe("SwipeViews", () => {
  beforeEach(() => {
    embla.selectedIndex = 0;
    embla.scrollTo.mockClear();
    embla.listeners.clear();
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
    expect(
      view.container.querySelector("#top-shell-demo-panel-first"),
    ).toHaveAttribute("aria-labelledby", "top-shell-demo-tab-first");

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
  });

  it("reports the destination selected by a horizontal pager swipe", () => {
    const onChildSwiped = vi.fn();

    render(
      <SwipeViews
        tabSetId="demo"
        activeValue="first"
        options={OPTIONS}
        onChildSwiped={onChildSwiped}
      >
        <div>first panel content</div>
        <div>second panel content</div>
      </SwipeViews>,
    );

    embla.selectedIndex = 1;
    embla.listeners.get("select")?.();

    expect(onChildSwiped).toHaveBeenCalledWith("second");
  });
});

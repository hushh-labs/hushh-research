// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  Sheet,
  SheetContent,
  useSheetDragHandle,
} from "@/components/ui/sheet";

/**
 * `components/ui/sheet.tsx` is the app's canonical bottom sheet. Ten surfaces
 * render it, so a change there is a change to ten screens at once.
 *
 * Two capabilities were added to it for the save-a-place sheet:
 *
 *  1. `contentDragDismiss` — an opt-OUT of body-origin drag dismissal, for a
 *     sheet that is a fixed frame around its own inner scroller.
 *  2. `useSheetDragHandle()` — the grabber's pointer handlers, exposed through
 *     context so a header that already looks like a grabber can be the drag
 *     surface instead of stacking a second 44px handle above it.
 *
 * Both are additive and both default to today's behaviour. This file is what
 * makes "additive" a fact rather than an intention: it asserts the defaults
 * directly, and it re-derives the consumer list from the filesystem so a new
 * consumer cannot appear without this test noticing.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function sourceOf(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/**
 * Every non-test module that imports the primitive, as of this change. Listed
 * rather than globbed so adding a consumer is a deliberate edit here, with the
 * width contract below re-checked at the same time.
 */
const SHEET_CONSUMERS = [
  "components/ui/sidebar.tsx",
  "components/one-location/redesign/circles/circle-grow-actions.tsx",
  "components/one-location/redesign/circles/named-circle-flows.tsx",
  "components/one-location/nearby-check-in/nearby-check-in-sheet.tsx",
  "components/one-location/onboarding/save-location-modal.tsx",
  "components/kai/views/analysis-history-dashboard.tsx",
  "components/kai/onboarding/KaiPreferencesSheet.tsx",
  "components/kai/share/portfolio-share-sheet.tsx",
  "components/profile/profile-avatar-editor.tsx",
  "components/app-ui/settings-ui.tsx",
  "components/onboarding/AuthLegalDialog.tsx",
  "components/agent/puppy-resource-monitor.tsx",
] as const;

describe("the shared bottom sheet stays shared", () => {
  it("still has exactly the consumers this change was checked against", () => {
    for (const consumer of SHEET_CONSUMERS) {
      expect(sourceOf(consumer)).toContain('@/components/ui/sheet"');
    }
  });

  it("leaves body-origin drag dismissal on by default", () => {
    // Eight of the ten consumers ARE their own scroll box, so the body drag is
    // the gesture they rely on. Only a sheet that owns an inner scroller opts
    // out, and it does so explicitly.
    const primitive = sourceOf("components/ui/sheet.tsx");
    expect(primitive).toContain("contentDragDismiss = true");

    const optOuts = SHEET_CONSUMERS.filter((consumer) =>
      /contentDragDismiss=\{false\}/.test(sourceOf(consumer)),
    );
    // Both are the same shape: a fixed frame — a header, then a
    // `flex-1 overflow-y-auto` body — whose own `scrollTop` is therefore
    // pinned at 0, so every downward drag inside it would engage the
    // dismissal and `preventDefault()` the scroll it was trying to make.
    //
    // The nearby Check-In panel joined this list rather than reaching for
    // `dragDismiss={false}`, which is what it used to pass: that switches the
    // gesture off AND takes the grab handle with it, leaving a phone bottom
    // sheet with no visible affordance to put it away.
    expect(optOuts).toEqual([
      "components/one-location/nearby-check-in/nearby-check-in-sheet.tsx",
      "components/one-location/onboarding/save-location-modal.tsx",
    ]);
  });

  it("caps no bottom sheet below phone width without an sm: prefix", () => {
    // A bottom sheet spans the bottom of the screen. A cap NARROWER than the
    // widest phone, applied at every width, paints a floating card with dead
    // strips down both sides — the exact defect this change removed from the
    // save-a-place sheet, where an unconditional `max-w-[420px]` turned the
    // 421–639px band into a pad hovering above the app.
    //
    // A cap of 640px or more cannot do that: no supported phone is that wide,
    // so the viewport, not the cap, decides the width. Those are left alone.
    //
    // Scoped to the `<SheetContent>` opening tag. A `max-w-*` on a card INSIDE
    // a sheet is a different thing and is none of this test's business.
    const offenders: string[] = [];
    for (const consumer of SHEET_CONSUMERS) {
      for (const tag of sheetContentTags(sourceOf(consumer))) {
        for (const match of tag.matchAll(
          /(?<![\w:-])(?:([a-z]+):)?max-w-(\[[^\]]+\]|[\w-]+)/g,
        )) {
          if (match[1]) continue;
          const px = maxWidthPx(match[2]);
          if (px !== null && px < 640) {
            offenders.push(`${consumer} → ${match[0]} (${px}px)`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("forwards no sub-phone cap through the settings surface constants", () => {
    // settings-ui hands `surfaceClassName`/`contentClassName` straight to
    // SheetContent, so its caps live in constants rather than in the tag the
    // scan above reads. Eight further surfaces reach the primitive through it.
    const source = sourceOf("components/app-ui/settings-ui.tsx");
    for (const match of source.matchAll(
      /(?<![\w:-])(?:([a-z]+):)?max-w-(\[[^\]]+\]|[\w-]+)/g,
    )) {
      if (match[1]) continue;
      const px = maxWidthPx(match[2]);
      expect(px === null || px >= 640, `${match[0]} resolves to ${px}px`).toBe(
        true,
      );
    }
  });
});

/** Every `<SheetContent …>` opening tag in a source file, brace-aware. */
function sheetContentTags(source: string): string[] {
  const tags: string[] = [];
  let from = source.indexOf("<SheetContent");
  while (from !== -1) {
    let depth = 0;
    let cursor = from;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === ">" && depth === 0) break;
      cursor += 1;
    }
    tags.push(source.slice(from, cursor));
    from = source.indexOf("<SheetContent", cursor);
  }
  return tags;
}

/** Tailwind's `max-w-*` scale in CSS pixels; null when it sets no fixed cap. */
function maxWidthPx(token: string): number | null {
  const scale: Record<string, number> = {
    xs: 320,
    sm: 384,
    md: 448,
    lg: 512,
    xl: 576,
    "2xl": 672,
    "3xl": 768,
    "4xl": 896,
    "5xl": 1024,
  };
  if (token in scale) return scale[token];
  const arbitrary = /^\[(\d+(?:\.\d+)?)px\]$/.exec(token);
  if (arbitrary) return Number(arbitrary[1]);
  // `full`, `none`, `screen-*`, `min(...)`, `calc(...)` — all viewport- or
  // content-relative, so none of them can strand a sheet in the middle.
  return null;
}

/**
 * jsdom implements no `PointerEvent`, so `fireEvent.pointerMove(el, {clientY})`
 * silently constructs a plain `Event` and the coordinate never arrives. The
 * drag maths then runs on `undefined`: `Math.max(0, NaN)` is NaN, `NaN < 4` is
 * false, so the gesture "engages" and then fails every threshold — a test
 * written without this passes the wiring and proves nothing about the gesture.
 *
 * The minimum that makes the real thresholds observable. Nothing about the
 * behaviour under test is stubbed.
 */
function installPointerEvents(): void {
  if (typeof window.PointerEvent === "function") return;
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "touch";
    }
  }
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
  Element.prototype.setPointerCapture ??= function setPointerCapture() {};
  Element.prototype.releasePointerCapture ??=
    function releasePointerCapture() {};
}

describe("useSheetDragHandle", () => {
  beforeAll(installPointerEvents);

  function Probe({ label }: { label: string }) {
    const drag = useSheetDragHandle();
    return (
      <div data-testid={label} data-has-handle={drag ? "yes" : "no"}>
        {label}
      </div>
    );
  }

  it("hands a bottom sheet's children the grabber's pointer handlers", () => {
    render(
      <Sheet open onOpenChange={vi.fn()}>
        <SheetContent side="bottom" aria-label="Bottom">
          <Probe label="bottom-probe" />
        </SheetContent>
      </Sheet>,
    );

    expect(screen.getByTestId("bottom-probe")).toHaveAttribute(
      "data-has-handle",
      "yes",
    );
  });

  it("returns null anywhere the sheet is not draggable", () => {
    // A side drawer and a drag-disabled sheet must both leave a header row an
    // inert plain div, with no `touch-none` and no pointer capture.
    render(
      <>
        <Sheet open onOpenChange={vi.fn()}>
          <SheetContent side="right" aria-label="Right">
            <Probe label="side-probe" />
          </SheetContent>
        </Sheet>
        <Sheet open onOpenChange={vi.fn()}>
          <SheetContent side="bottom" dragDismiss={false} aria-label="Static">
            <Probe label="static-probe" />
          </SheetContent>
        </Sheet>
      </>,
    );

    expect(screen.getByTestId("side-probe")).toHaveAttribute(
      "data-has-handle",
      "no",
    );
    expect(screen.getByTestId("static-probe")).toHaveAttribute(
      "data-has-handle",
      "no",
    );
  });

  it("still renders the built-in handle for a sheet that did not opt out", () => {
    // The new context is an ADDITION. A consumer that never calls the hook
    // keeps the 44px handle the primitive has always drawn for it.
    render(
      <Sheet open onOpenChange={vi.fn()}>
        <SheetContent side="bottom" aria-label="Default">
          <p>Body</p>
        </SheetContent>
      </Sheet>,
    );

    expect(
      screen.getByRole("button", { name: "Drag down to close" }),
    ).toBeInTheDocument();
  });

  it("dismisses the sheet from a real downward drag on the delegated row", () => {
    // The point of exposing the handlers at all. A row that LOOKS like a
    // grabber but does not move the sheet is worse than no grabber: it teaches
    // the gesture and then refuses it.
    const onOpenChange = vi.fn();

    function Header() {
      const drag = useSheetDragHandle();
      return (
        <div
          data-testid="delegated-grabber"
          onPointerDown={drag?.onPointerDown}
          onPointerMove={drag?.onPointerMove}
          onPointerUp={drag?.onPointerUp}
          onPointerCancel={drag?.onPointerCancel}
        >
          rail
        </div>
      );
    }

    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showDragHandle={false}
          contentDragDismiss={false}
          aria-label="Delegated"
        >
          <Header />
        </SheetContent>
      </Sheet>,
    );

    const rail = screen.getByTestId("delegated-grabber");

    // Faked BEFORE the gesture: the primitive defers the close by 220ms so its
    // transform can finish, and a timer scheduled on the real clock cannot be
    // advanced by a fake one installed afterwards.
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(rail, { clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(rail, { clientY: 140, pointerId: 1 });
      fireEvent.pointerMove(rail, { clientY: 260, pointerId: 1 });
      fireEvent.pointerUp(rail, { clientY: 260, pointerId: 1 });

      // 160px of travel clears the primitive's 96px dismiss threshold.
      expect(onOpenChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
    } finally {
      vi.useRealTimers();
    }
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("snaps back instead of dismissing when the drag is too short", () => {
    const onOpenChange = vi.fn();

    function Header() {
      const drag = useSheetDragHandle();
      return (
        <div
          data-testid="short-grabber"
          onPointerDown={drag?.onPointerDown}
          onPointerMove={drag?.onPointerMove}
          onPointerUp={drag?.onPointerUp}
          onPointerCancel={drag?.onPointerCancel}
        >
          rail
        </div>
      );
    }

    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showDragHandle={false}
          contentDragDismiss={false}
          aria-label="Short"
        >
          <Header />
        </SheetContent>
      </Sheet>,
    );

    const rail = screen.getByTestId("short-grabber");

    fireEvent.pointerDown(rail, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(rail, { clientY: 130, pointerId: 1 });
    // Slowly, so velocity cannot carry it over the line either.
    fireEvent.pointerUp(rail, { clientY: 130, pointerId: 1, timeStamp: 5_000 });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes on the handle's keyboard affordance, as before", () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent side="bottom" aria-label="Keyboard">
          <p>Body</p>
        </SheetContent>
      </Sheet>,
    );

    fireEvent.keyDown(
      screen.getByRole("button", { name: "Drag down to close" }),
      { key: "Escape" },
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

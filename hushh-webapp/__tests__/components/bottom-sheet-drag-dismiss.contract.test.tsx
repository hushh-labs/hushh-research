import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * Which drag surfaces a bottom sheet exposes.
 *
 * `SheetContent` has two: the grab handle, and the content body. The body rule
 * engages when `surface.scrollTop <= 0`, which is exactly right for a sheet
 * that scrolls itself — you can only pull it down once you are already at the
 * top of it.
 *
 * It is exactly wrong for a sheet that owns an INNER scroll container. That
 * sheet's own `scrollTop` is pinned at 0 forever, so every downward swipe over
 * its content reads as a dismissal and the list inside never scrolls at all.
 * The nearby Check-In panel is one of those: a fixed header, then a
 * `flex-1 overflow-y-auto` body holding the place list.
 *
 * `dragDismiss="handle"` is the third state between "drag anywhere" and the
 * old workaround of switching the gesture off entirely — which also removed
 * the handle, leaving a phone bottom sheet with no grab affordance at all.
 *
 * WHAT THIS FILE DOES NOT DO: drive the gesture. JSDOM performs no layout and
 * no real pointer capture, and the body-drag path does not engage there even
 * on a default sheet — so a "swiping the body did not dismiss" assertion would
 * pass vacuously and prove nothing. What is asserted here is the wiring, which
 * is the part that actually changed; the drag mechanics themselves are the
 * pre-existing hook and are untouched.
 */

function renderSheet(dragDismiss: boolean | "handle") {
  render(
    <Sheet open modal={false} onOpenChange={vi.fn()}>
      <SheetContent
        side="bottom"
        dragDismiss={dragDismiss}
        showOverlay={false}
        className="gap-0 overflow-hidden px-0"
      >
        <SheetHeader>
          <SheetTitle>Check in</SheetTitle>
        </SheetHeader>
        <div data-testid="inner-scroller" className="min-h-0 flex-1 overflow-y-auto">
          <button type="button">A place</button>
        </div>
      </SheetContent>
    </Sheet>,
  );
}

const dragHandle = () =>
  document.querySelector('[data-slot="sheet-drag-handle"]');

describe("bottom sheet drag surfaces", () => {
  it('gives a "handle" sheet the grab affordance a phone expects', () => {
    renderSheet("handle");
    const handle = dragHandle();
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute("aria-label", "Drag down to close");
    // Phone-only: from `sm` the same component is a side rail with no handle.
    expect(handle?.className).toContain("sm:hidden");
  });

  it("still renders the handle for a default bottom sheet", () => {
    renderSheet(true);
    expect(dragHandle()).toBeInTheDocument();
  });

  it("renders no handle at all when the gesture is switched off", () => {
    renderSheet(false);
    // This is what the Check-In panel used to be. A bottom sheet with no
    // handle reads to a phone user as a card that arrived, not a sheet they
    // can put away.
    expect(dragHandle()).toBeNull();
  });

  it("keeps the close button above the handle it overlaps", () => {
    renderSheet("handle");
    // The handle is a full-width `z-[5] touch-none` band across the top 44px,
    // and the close button's 44px hit region (`after:-inset-1.5` on a 32px
    // circle at `top-4`) reaches up into it from y=10. Without an explicit
    // layer the handle is painted over three quarters of the close target and
    // swallows its taps — on every bottom sheet that shows both.
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.className).toContain("z-10");
    expect(dragHandle()?.className).toContain("z-[5]");
  });
});

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * The close button and the drag handle share the top of every bottom sheet.
 *
 * The handle is a full-width `z-[5] touch-none` band occupying y=0..44. The
 * close button sits at `top-4` as a 32px circle whose hit region is widened to
 * the platform's 44px minimum by `after:-inset-1.5` — so it starts at y=10 and
 * three quarters of it lies underneath the handle. Without an explicit layer
 * the handle wins on stacking order and swallows those taps, on every sheet
 * that shows both: the close button looks fine and does nothing for most of
 * its own target.
 *
 * `shared-sheet-consumers.contract.test.tsx` owns everything else about this
 * primitive — the `contentDragDismiss` default, `useSheetDragHandle`, the
 * consumer list, and the real drag mechanics. This file is only the layering,
 * which nothing else asserts.
 *
 * It exists as its own file because it is also the reason
 * `components/ui/sheet.tsx` now has a CI lane at all: before
 * `verify:bottom-sheet`, a change confined to the one component that decides
 * whether ten surfaces can be dismissed ran no test on a pull request.
 */

function renderSheet(contentDragDismiss: boolean) {
  render(
    <Sheet open modal={false} onOpenChange={vi.fn()}>
      <SheetContent
        side="bottom"
        contentDragDismiss={contentDragDismiss}
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

describe("the close button and the drag handle", () => {
  it("layers the close button above the handle it overlaps", () => {
    renderSheet(false);
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.className).toContain("z-10");
    expect(dragHandle()?.className).toContain("z-[5]");
  });

  it("keeps the handle for a sheet that only opts out of body drag", () => {
    // The Check-In panel's shape: it cannot use body drag, because it owns an
    // inner scroller and its own scrollTop never leaves 0. Opting out of that
    // must not cost it the grab affordance as well — `dragDismiss={false}`
    // would have removed both.
    renderSheet(false);
    const handle = dragHandle();
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute("aria-label", "Drag down to close");
    // Phone-only: from `sm` the same component is a side rail with no handle.
    expect(handle?.className).toContain("sm:hidden");
  });
});

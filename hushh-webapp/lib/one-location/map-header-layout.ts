/**
 * Layout classes for the Location map header, in their own dependency-free
 * module so a real-browser geometry test can import the exact strings that
 * ship. (The component itself pulls in Capacitor, lucide and next/navigation,
 * none of which can be loaded by a plain Node test runner.)
 *
 * A test that re-declares these strings measures a copy, and a copy drifts
 * silently -- which is exactly how "Check in" reached a user as "C" while every
 * test stayed green. See e2e/location-map-header.contract.spec.ts.
 */

/**
 * A grid, not a flex row: with flex + justify-between, three-plus items of
 * uneven width get spread by *equal gaps*, which is what dragged Check-in and
 * Sharing out of place in the first place.
 *
 * From `sm` up, `1fr auto 1fr` forces the two outer columns to the same width
 * regardless of what they contain, which puts the middle (auto) column --
 * Sharing -- at the header's true visual centre no matter how wide the close X
 * or the Check-in+Locate group are.
 *
 * Below `sm` -- i.e. every phone -- that same symmetry is what broke the
 * header. Making the left column (one 56px X) as wide as the right one
 * (Check-in + Locate) burns ~95px on empty space, and the leftover centre
 * column could not hold "Sharing with 2" AND let Check-in keep its label.
 * Measured in Chromium against this stylesheet, "Check in" was truncated at
 * EVERY phone width tested -- 320, 360, 375, 390 and 430 -- reaching the
 * reporter as the single letter "C". A product-owned action word is not an
 * acceptable thing to truncate, so the phone layout gives row 1 to the controls
 * at their natural widths and drops Sharing onto its own full-width row
 * beneath them. Nothing truncates, and the Sharing popover gains the room it
 * needs to open without being clipped by the screen edge.
 */
export const MAP_HEADER_CLASSNAME =
  "pointer-events-none absolute inset-x-0 top-0 z-30 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:grid-cols-[1fr_auto_1fr]";

export const MAP_HEADER_CLOSE_CELL_CLASSNAME =
  "col-start-1 row-start-1 flex min-w-0 items-center";

export const MAP_HEADER_STATUS_CELL_CLASSNAME =
  "col-span-2 col-start-1 row-start-2 flex min-w-0 items-center justify-center sm:col-span-1 sm:col-start-2 sm:row-start-1";

export const MAP_HEADER_ACTIONS_CELL_CLASSNAME =
  "col-start-2 row-start-1 flex min-w-0 items-center justify-end gap-3 sm:col-start-3";

/** The `sm` breakpoint: below it the header is two rows, at or above it one. */
export const MAP_HEADER_SINGLE_ROW_MIN_WIDTH = 640;

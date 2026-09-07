/**
 * Vertical rhythm for the bottom sheets a Circle raises -- Add people, Invite
 * code, Rename Circle.
 *
 * Reported from phone QA on Add people: "extra space between the section is
 * bad", "search bahut jyada neeche aa raha", "divs truncated bhi dikh rahe
 * hain". Measured, the gap between "Choose connections." and the search field
 * was 48px, and none of it was asked for by this screen. It was four owners
 * each adding their own default on top of the last:
 *
 *   SheetContent   flex flex-col gap-4   +16px between every child
 *   SheetHeader    p-4                   +16px below the description
 *                                        (and +16px to its LEFT, on top of
 *                                        the sheet's own px-4, so the title
 *                                        sat indented from the field under it)
 *   the body       mt-4                  +16px again
 *
 * and then, below the field, `SettingsGroup`'s `mt-7` added 28px more before
 * "Your connections" -- a margin that is correct on a settings SCREEN, where
 * it separates one section from the section above, and wrong in a sheet,
 * where there is no section above.
 *
 * None of those four is a bug on its own, which is why this drifted: every
 * layer was defaulting sensibly for a context it could not see. So the sheet
 * states its rhythm here, once, and the three sheets share it -- rather than
 * each carrying inline numbers that can only be compared by opening all three
 * files.
 *
 * ## Visual Map
 *
 *   before                              after
 *   +--------------------------+        +--------------------------+
 *   |                          |        | Add people               |
 *   |     Add people           |        | Choose connections.      |
 *   |     Choose connections.  |        |  [ Q  Search people    ] |
 *   |                          |        | Your connections         |
 *   |                          |        | +----------------------+ |
 *   |  [ Q  Search people    ] |        | | Ankit Kumar Singh  o | |
 *   |                          |        | | Neelesh Meena      o | |
 *   |                          |        | +----------------------+ |
 *   | Your connections         |        |  [   Add 2 people    ]   |
 *   | +----------------------+ |        +--------------------------+
 *   | | Ankit Kumar Singh  o | |
 *   | | Neelesh Meena  (cut) | |
 *   +--------------------------+
 */

/**
 * The sheet's header, aligned with the body under it.
 *
 * `p-0` before `pt-5`, not `px-0 pt-5 pb-0`: `SheetHeader`'s own `p-4` is a
 * single shorthand, and clearing it side by side leaves the reader checking
 * four tailwind-merge groups to be sure nothing survived. One reset, then the
 * one value this surface wants back.
 *
 * The horizontal padding belongs to `SheetContent` (`px-4 sm:px-6`), which is
 * what the search field and the list are measured against -- so the title
 * lines up with them instead of sitting 16px inboard of both.
 *
 * `pt-5` and not the `pt-1` this started at, because the top padding is the
 * only thing holding the title off a 24px corner. The sheets round their top
 * at `rounded-t-[24px]` and the title starts at the `px-4` gutter, 16px in --
 * which is still inside that corner's 24px arc. Solve the circle there and
 * the surface only begins about 1.4px down, so 4px of padding left the title
 * sitting in the curve rather than below it, and it read as text crowding the
 * rounded edge.
 *
 * 20px clears the arc, and it also lands the title's optical centre within a
 * couple of pixels of the close button's, which `SheetContent` pins at
 * `top-4` with a 32px box (centre 32px; the title's is ~34px). Matching the
 * radius exactly at `pt-6` would clear the curve just as well but push the
 * title 6px below that centre, so the X would read as floating high.
 */
export const CIRCLE_SHEET_HEADER_CLASSNAME = "p-0 pt-5 text-left";

/**
 * A sheet body that is simply as tall as its content (Rename, Invite code).
 *
 * `mt-1` and not `mt-5`: `SheetContent`'s `gap-4` has already put 16px between
 * the header and this, so the margin's whole job is the last 4px.
 */
export const CIRCLE_SHEET_BODY_CLASSNAME = "mt-1 space-y-4";

/**
 * A sheet body that OWNS the remaining height and scrolls inside it -- the
 * shape Add people needs, so its "Add N people" button stays on screen while
 * the roster moves under it.
 */
export const CIRCLE_SHEET_SCROLL_BODY_CLASSNAME =
  "mt-1 flex min-h-0 flex-1 flex-col gap-3";

/**
 * The scrolling region itself.
 *
 * `-mx-1 px-1` is the "truncated divs" half of the report: an
 * `overflow-y-auto` box clips at its own padding edge, so a card sitting flush
 * against it lost the outer pixels of its rounded corner and all of its
 * shadow, and read as a row cut in half rather than a list that scrolls. One
 * pixel of gutter, pulled back out with a negative margin so nothing moves.
 *
 * `pb-2` keeps the last card off the clip edge for the same reason.
 */
export const CIRCLE_SHEET_SCROLL_AREA_CLASSNAME =
  "-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-2 [-webkit-overflow-scrolling:touch]";

/**
 * A `SettingsGroup` heading INSIDE a sheet.
 *
 * The group's own `mt-7` separates one section from the one above it. The
 * first group in a sheet has nothing above it but the sheet's own header,
 * which has already introduced the list, so the margin is pure gap.
 */
export const CIRCLE_SHEET_FIRST_GROUP_HEADING_CLASSNAME = "mt-0";

/** A second group under the first, where some separation IS the point -- but
 *  28px on top of the stack gap is two section breaks for one boundary. */
export const CIRCLE_SHEET_NEXT_GROUP_HEADING_CLASSNAME = "mt-2";

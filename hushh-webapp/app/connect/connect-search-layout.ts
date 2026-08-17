/**
 * Geometry for Connect's search row, in one place both the screen and the
 * browser layout contract read from.
 *
 * The row is a search field and a selection toggle sharing one line. QA found
 * it clipped on a phone: the placeholder rendered as "Search people by nam".
 * Three separate things were spending the row's width, and only one of them
 * was the label:
 *
 *  1. The placeholder was five words where two carry the meaning.
 *  2. The toggle said "Select multiple" -- ~55px explaining a mode whose own
 *     section description already explains it.
 *  3. The field reserved `pr-11` (44px) for the clear button at all times,
 *     including while empty -- i.e. at exactly the moment the placeholder is
 *     the only thing in the field and the button does not exist.
 *
 * Values live here rather than inline so `e2e/connect-circle-cta.layout.spec.ts`
 * can measure the real strings. A fixture that hand-copies them stops proving
 * anything the first time one changes.
 */

/**
 * One word. The narrowest supported phone has to be able to read all of it.
 *
 * Two words did not, once the layout contract started measuring the typeface the
 * app actually ships instead of the one the test machine happened to have:
 * "Search people" needs 116.2px of the 116.0px the field gives it at 320px. The
 * previous fix was calibrated against a narrower fallback face and landed on the
 * boundary, which is the same clipping QA reported ("Search people by nam"),
 * two words later.
 *
 * The field already carries a magnifier glyph and sits above a list of people,
 * and its accessible name stays "Search people" (see `aria-label` in
 * page-client.tsx), so the word the placeholder drops is the one the screen was
 * already saying twice.
 */
export const CONNECT_SEARCH_PLACEHOLDER = "Search";

/** Left inset clears the search glyph; the right one is conditional. */
export const CONNECT_SEARCH_INPUT_CLASSNAME = "h-10 pl-11";

/** Added only while the clear button is actually in the gutter. */
export const CONNECT_SEARCH_INPUT_CLEARABLE_CLASSNAME = "pr-11";

/** Used while the gutter is empty, so the placeholder gets the space back. */
export const CONNECT_SEARCH_INPUT_PLAIN_CLASSNAME = "pr-3.5";

/**
 * The selection toggle, at a fixed width so switching between "Select many"
 * and "Cancel" cannot resize the search field beside it.
 *
 * 104px, not 84px: the label has to say that it selects MORE THAN ONE person
 * before it is pressed. "Select" alone read as "select this one", which is the
 * opposite of what the control does. The width is measured against the widest
 * of the two labels at 320px in `connect-circle-cta.layout.spec.ts`.
 */
export const CONNECT_SELECT_TOGGLE_CLASSNAME =
  "h-10 min-h-10 w-[104px] shrink-0 rounded-full px-0 text-[15px] font-semibold leading-5";

/** Gap between the field and the toggle (`gap-2`). */
export const CONNECT_SEARCH_ROW_GAP_PX = 8;

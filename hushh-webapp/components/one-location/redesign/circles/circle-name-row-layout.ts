/**
 * Geometry for the Circle name field and the control beside it.
 *
 * QA's note was "Save CTA, not looking good". The cause was measurable rather
 * than a matter of taste: the Save button took `Button`'s `default` size, whose
 * `min-h-[50px]` outlives the `h-11` the caller set, because `h-` and `min-h-`
 * are separate tailwind-merge groups and the override never landed. Save
 * rendered 50px tall against a 44px field -- 6px proud of it on both edges.
 *
 * The second half was movement. Save is wider than a pencil glyph, so sizing
 * each state to its own content resized the input on the first keystroke and
 * again on save. Both states now share one width.
 *
 * Values live here rather than inline so `e2e/connect-circle-cta.layout.spec.ts`
 * can measure the real strings in the real cascade.
 */

/** The field's height, and therefore the control's. */
export const CIRCLE_NAME_ROW_HEIGHT_PX = 44;

/** Shared by both trailing states, so neither can drift from the other. */
export const CIRCLE_NAME_ACTION_CLASSNAME =
  "h-11 min-h-11 w-[72px] shrink-0 rounded-xl px-0 text-[15px] font-semibold";

export const CIRCLE_NAME_INPUT_CLASSNAME =
  "h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-base outline-none transition focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent-ring)]";

/** The field and its control sit on one line (`flex items-center gap-2`). */
export const CIRCLE_NAME_ROW_CLASSNAME = "mt-2 flex items-center gap-2";

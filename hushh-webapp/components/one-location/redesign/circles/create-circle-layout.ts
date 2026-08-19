/**
 * The Create-a-circle screen's two sized controls, as shared strings.
 *
 * They live here for the same reason `circle-name-row-layout.ts` does: a
 * browser layout contract has to measure *these* strings, not a copy of them.
 * A duplicated class list in a spec proves the spec, not the screen — and it
 * goes stale the first time someone edits the component and not the test.
 *
 * The screen has a lock state now (Circles are reachable without a lock), so
 * the primary action also renders in a loading state while that state settles.
 * Both states are measured against `CREATE_CIRCLE_CTA_MIN_HEIGHT_PX`.
 */

/** Minimum touch target, and the height both CTA states must hold. */
export const CREATE_CIRCLE_CTA_MIN_HEIGHT_PX = 54;

/** Minimum comfortable touch target for the name field. */
export const CREATE_CIRCLE_NAME_INPUT_HEIGHT_PX = 56;

/** Sizing half of the primary action. Composed with `BLOCKED_CTA` at the call
 *  site, exactly as the screen does. */
export const CREATE_CIRCLE_CTA_CLASSNAME =
  "h-[54px] w-full rounded-full text-base font-semibold";

export const CREATE_CIRCLE_NAME_INPUT_CLASSNAME =
  "h-14 w-full rounded-2xl border border-border bg-[color:var(--app-card-surface-default-solid)] px-4 text-base outline-none transition focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent-ring)]";

export const CREATE_CIRCLE_NAME_PLACEHOLDER = "e.g. Family";

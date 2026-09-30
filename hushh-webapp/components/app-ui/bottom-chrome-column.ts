/**
 * The single column every persistent bottom bar sits in.
 *
 * The "Talk to One" bar (command or live voice), the navigation pill, and the
 * voice panel or command transcript docked above them are one column: the
 * same width and the same left and right edges at every viewport. The width
 * and the inset are CSS tokens in `app/globals.css`
 * (`--app-bottom-shell-max-width`, `--app-bottom-shell-inline-inset`); these
 * classes are the only way a bar consumes them.
 *
 * Widths are container-relative, never `100vw`: `100vw` counts a desktop
 * scrollbar and ignores the shell moving over for the chat history column,
 * so a viewport-derived width drifts off the column it is meant to fill.
 *
 * Held by e2e/bottom-chrome-width.layout.spec.ts.
 */

/** Horizontal inset of a container that places bars on the screen. */
export const BOTTOM_CHROME_INSET_CLASSNAME =
  "px-[var(--app-bottom-shell-inline-inset)]";

/** A bar, or the stack of bars, filling the shared column. */
export const BOTTOM_CHROME_COLUMN_CLASSNAME =
  "w-full max-w-[var(--app-bottom-shell-max-width)]";

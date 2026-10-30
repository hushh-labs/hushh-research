/** Responsive action geometry shared by single- and multi-lane share rows. */
export const ACTIVE_SHARE_ACTIONS_CLASSNAME =
  "flex w-full min-w-0 items-center gap-2 sm:w-auto sm:justify-end sm:gap-3";

export const ACTIVE_SHARE_CHANGE_TIME_CLASSNAME =
  "ui-text-compact-button-label inline-flex min-h-11 shrink-0 items-center justify-center rounded-full px-2 text-[color:var(--app-accent)] transition-colors hover:bg-[color:var(--app-accent)]/10 active:bg-[color:var(--app-accent)]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60";

export const ACTIVE_SHARE_STOP_CLASSNAME =
  "ui-text-compact-button-label ml-auto inline-flex min-h-11 shrink-0 items-center justify-center rounded-full px-2 text-[color:var(--app-destructive)] transition-colors hover:bg-[color:var(--app-destructive)]/10 active:bg-[color:var(--app-destructive)]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60 sm:ml-0";

export const ACTIVE_SHARE_LANE_ROW_CLASSNAME =
  "flex min-h-[54px] flex-col items-stretch gap-1 py-1.5 sm:flex-row sm:items-center sm:gap-3";

export const ACTIVE_SHARE_LANE_ACTIONS_CLASSNAME =
  "ml-auto flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end sm:gap-3";

/** The same three tracks own the column headings and every recipient row. */
export const ACTIVE_SHARE_COMPARISON_GRID_CLASSNAME =
  "grid min-w-0 grid-cols-1 gap-2.5 @min-[46rem]:grid-cols-[minmax(0,0.9fr)_repeat(2,minmax(0,1fr))] @min-[46rem]:items-center @min-[46rem]:gap-4";

export const ACTIVE_SHARE_COMPARISON_CELL_CLASSNAME =
  "grid min-h-11 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2";

/** Mobile groups contain one channel per recipient, without nested lane cards. */
export const ACTIVE_SHARE_CATEGORY_ROW_CLASSNAME =
  "grid min-w-0 grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-[var(--settings-row-gap)]";

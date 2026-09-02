export const CONNECT_DIRECTORY_MENU_CLASSNAME =
  "absolute left-0 top-full z-30 mt-1 w-[184px] overflow-hidden rounded-[14px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-1 shadow-[0_10px_30px_rgba(0,0,0,0.10)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.35)]";

export const CONNECT_CONNECTIONS_SUMMARY_TRAILING_CLASSNAME =
  "flex shrink-0 items-center gap-2";

export const CONNECT_CONNECTIONS_SUMMARY_COUNT_CLASSNAME =
  "min-w-5 text-right text-[14px] font-medium tabular-nums text-[color:var(--app-secondary-label)]";

export const CONNECT_CONNECTIONS_SUMMARY_CHEVRON_CLASSNAME =
  "h-4 w-4 shrink-0 text-[color:var(--app-secondary-label)] transition-transform duration-200 ease-out motion-reduce:transition-none group-data-[state=open]/connections:rotate-180";

/**
 * The app scroll root is the only vertical scroll owner on Connect.
 *
 * Do not add `overflow-x-hidden` here: CSS computes the otherwise-visible y
 * axis to `auto`, silently turning this region into a second scroll container.
 * That breaks the sticky tab/search bands and traps phone gestures. The route
 * shell already clips horizontal overflow.
 */
export const CONNECT_PAGE_CONTENT_CLASSNAME = "min-w-0";

/** Let identities use the room a responsive row gives them instead of cutting
 * meaningful names and masked contact details behind an ellipsis. */
export const CONNECT_WRAPPING_TEXT_CLASSNAME =
  "block min-w-0 whitespace-normal [overflow-wrap:anywhere]";

/** A source badge may wrap after a long identity without forcing the identity
 * itself to disappear. */
export const CONNECT_WRAPPING_TITLE_ROW_CLASSNAME =
  "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5";

/** Phones keep one natural page scroller. A bounded inner roster is useful on
 * larger screens, where wheel/trackpad input does not create a gesture trap. */
export const CONNECT_DESKTOP_CONNECTION_LIST_CLASSNAME =
  "sm:max-h-[320px] sm:overflow-y-auto sm:overscroll-contain sm:[-webkit-overflow-scrolling:touch]";

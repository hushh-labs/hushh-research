/**
 * Geometry for the contact-sync bottom sheets, kept out of the components so
 * `e2e/contact-invitation-sheet.layout.spec.ts` measures the real strings.
 *
 * THE HEIGHT CAP. The sheet primitive already lifts a bottom sheet above the
 * on-screen keyboard (`bottom-[var(--kb-height)]`). These sheets used to cap
 * themselves at `88dvh - keyboard` as well, which subtracted the keyboard a
 * second time: with it up, an iPhone 8 sheet stopped 80px below the top of the
 * free space and the list under "Search contacts…" got 42px, an iPhone SE 24px.
 * The cap is now the smaller of the old 88dvh look and the space actually left
 * above the keyboard (less the status bar and a small gap).
 */
export const CONTACT_SHEET_MAX_HEIGHT_CLASSNAME =
  "max-h-[min(88dvh,calc(100dvh-var(--kb-height,0px)-var(--app-safe-area-top-effective,0px)-1rem))]";

/**
 * THE FRAME. A fixed frame whose middle row is the only scroller, rather than
 * one scroll box with a search field inside it.
 *
 * `overflow-y-hidden`, not `overflow-hidden`: tailwind-merge files the two
 * under different keys, so `overflow-hidden` would leave the primitive's
 * `overflow-y-auto` standing and the whole sheet would keep scrolling.
 * `gap-0 p-0` because each row supplies its own inset.
 */
export const CONTACT_INVITE_SURFACE_CLASSNAME = `mx-auto flex w-full max-w-2xl flex-col gap-0 overflow-y-hidden rounded-t-[24px] p-0 ${CONTACT_SHEET_MAX_HEIGHT_CLASSNAME}`;

/** Title block. Only the title shares a line with the close button. */
export const CONTACT_INVITE_HEADER_CLASSNAME =
  "shrink-0 gap-1 px-4 pb-3 pt-4 text-left sm:px-6";

/** Clears the primitive's 32px close button at `right-4 top-4`. */
export const CONTACT_INVITE_TITLE_CLASSNAME = "pr-10";

/** The search field, pinned above the rows it filters so it never scrolls away. */
export const CONTACT_INVITE_SEARCH_CLASSNAME = "shrink-0 px-4 pb-2 sm:px-6";

/**
 * The only scrolling element. `min-h-0` lets it shrink below its content in
 * the column, which is what makes it scroll instead of pushing the footer out.
 */
export const CONTACT_INVITE_LIST_CLASSNAME =
  "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3 [-webkit-overflow-scrolling:touch] sm:px-6";

/**
 * The home-indicator inset for the list when there is no footer below it (the
 * one-at-a-time queue step). The sheet itself no longer pads its bottom.
 */
export const CONTACT_INVITE_LIST_TRAILING_INSET_CLASSNAME =
  "pb-[max(1rem,env(safe-area-inset-bottom))]";

/** Pinned action row; the home-indicator inset lives in its padding. */
export const CONTACT_INVITE_FOOTER_CLASSNAME =
  "flex shrink-0 flex-col gap-1 border-t border-border px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6";

/**
 * The footer is one column: the action that moves forward on top at full
 * width, the way back directly under it at the same width and height. A short
 * outlined "Back" parked above a wide primary read as two unrelated controls.
 */
export const CONTACT_INVITE_PRIMARY_ACTION_CLASSNAME =
  "h-12 min-h-12 w-full rounded-full text-[17px] font-semibold";
export const CONTACT_INVITE_SECONDARY_ACTION_CLASSNAME =
  "h-12 min-h-12 w-full rounded-full text-[17px] font-medium text-muted-foreground";

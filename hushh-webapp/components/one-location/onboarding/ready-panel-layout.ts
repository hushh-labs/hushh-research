/**
 * Layout contract for the final onboarding screen ("You're on the map").
 *
 * These class strings live here rather than inline so the component and the
 * layout tests read the same source. The centring below was a real bug: the
 * panel used to be anchored to the right edge (`md:right-[max(44px,6vw)]`) over
 * a full-bleed map, which read as a panel that had slid off rather than a
 * dialog over the map.
 *
 * The geometry these classes must produce is asserted two ways, because neither
 * check alone is sufficient:
 *
 *   - `__tests__/components/one-location-onboarding-flow.test.tsx` proves the
 *     component still renders these classes. It runs in the normal test gate,
 *     but JSDOM performs no layout, so it cannot prove what they do.
 *   - `e2e/one-location-ready-panel.layout.spec.ts` renders them in a real
 *     browser and measures the box. It proves the centring, but needs a browser
 *     binary, so it is run on demand rather than in the default gate.
 */

/** Full-bleed surface the map and panel sit in. Owns the positioning context. */
export const READY_SURFACE_CLASSNAME =
  "relative flex min-h-0 flex-1 flex-col overflow-hidden bg-white dark:bg-[#14171d] md:bg-[#eef3f8] md:dark:bg-[#070a0f]";

/** A band of its own on phones; the full backdrop from `md:` up. */
export const READY_MAP_CLASSNAME =
  "h-[34dvh] max-h-[300px] min-h-[190px] w-full shrink-0 md:absolute md:inset-0 md:h-full md:max-h-none md:min-h-0";

/**
 * Phones keep the full-width sheet in normal flow -- that is also what the iOS
 * build renders, so the `md:` rules must never leak into phone widths. From
 * `md:` up the panel becomes a fixed-width dialog centred on both axes.
 */
export const READY_PANEL_CLASSNAME =
  "relative z-10 -mt-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-[28px] bg-white shadow-[0_-8px_24px_rgba(24,57,91,0.10)] dark:bg-[#14171d] md:absolute md:left-1/2 md:top-1/2 md:mt-0 md:h-auto md:max-h-[calc(100dvh-96px)] md:w-[430px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-[30px] md:shadow-[0_24px_80px_rgba(24,57,91,0.22)]";

/** Tailwind's `md:` breakpoint -- where the sheet becomes a centred dialog. */
export const READY_PANEL_DIALOG_MIN_WIDTH_PX = 768;

/** The panel's fixed width once it is a dialog (`md:w-[430px]`). */
export const READY_PANEL_DIALOG_WIDTH_PX = 430;

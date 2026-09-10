/**
 * Phone-safe geometry for the Location header's switch and status caption.
 * Kept outside the component so browser layout tests measure the shipped
 * classes instead of a copied approximation.
 */

/**
 * Keep the switch legible without letting it become a detached desktop island.
 *
 * Very narrow phones stack the caption under the switch to preserve the title.
 * From 400px onward the caption sits beside the switch, and the desktop header
 * keeps the whole control next to the title instead of at the far edge of the
 * 880px agent shell.
 */
export const LOCATION_HEADER_ACTIONS_CLASSNAME =
  "ml-auto flex min-h-[64px] w-[104px] max-w-[45vw] shrink-0 flex-col items-center justify-center min-[400px]:min-h-11 min-[400px]:w-auto min-[400px]:max-w-none min-[400px]:flex-row-reverse min-[400px]:gap-2 sm:ml-0";

export const LOCATION_HEADER_STATUS_CLASSNAME =
  "mt-1 block max-w-full whitespace-nowrap text-center font-[family-name:var(--font-app-body)] text-[12px] font-normal leading-4 tracking-[-0.01em] text-[color:var(--app-secondary-label)] min-[400px]:mt-0";

export const LOCATION_HUB_PAGE_HEADER_CLASSNAME =
  "[&>div:first-child]:!gap-3 sm:[&>div:first-child]:!gap-3.5 [&_[data-slot=page-header-actions]]:!self-center [&_[data-slot=page-header-row]]:!items-center [&_[data-slot=page-header-row]]:!gap-2 min-[400px]:[&_[data-slot=page-header-row]]:!gap-3 sm:[&_[data-slot=page-header-row]]:!justify-start sm:[&_[data-slot=page-header-row]]:!gap-0 sm:[&_[data-slot=page-header-copy]]:!flex-none sm:[&_[data-slot=page-header-actions]]:!ml-5 sm:[&_[data-slot=page-header-actions]]:!justify-start";

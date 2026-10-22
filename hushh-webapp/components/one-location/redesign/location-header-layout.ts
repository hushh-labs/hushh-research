/**
 * Phone-safe geometry for the Location header's switch and status caption.
 * Kept outside the component so browser layout tests measure the shipped
 * classes instead of a copied approximation.
 */

/**
 * Keep the switch legible without letting it become a detached desktop island.
 *
 * Stack the compact caption under the switch at every width. The label owns a
 * 44px tap target, with the track widened to match the caption's text measure.
 */
export const LOCATION_HEADER_ACTIONS_CLASSNAME =
  "ml-auto flex min-h-0 w-[92px] shrink-0 flex-col items-center justify-center overflow-visible";

export const LOCATION_HEADER_STATUS_CLASSNAME =
  "mt-0.5 block w-full whitespace-normal text-center font-[family-name:var(--font-app-body)] text-[11px] font-medium leading-[14px] tracking-[-0.01em] text-[color:var(--app-secondary-label)]";

export const LOCATION_HEADER_TOGGLE_LABEL_CLASSNAME =
  "flex min-h-11 w-full cursor-pointer flex-col items-center justify-center";

/** 10% narrower than the previous 60px track, with the same thumb and insets. */
export const LOCATION_HEADER_SWITCH_CLASSNAME =
  "shrink-0 data-[size=default]:h-6 data-[size=default]:w-[3.375rem] [&_[data-slot=switch-thumb]]:!size-5 [&_[data-slot=switch-thumb][data-state=checked]]:!translate-x-[1.875rem]";

export const LOCATION_HUB_PAGE_HEADER_CLASSNAME =
  "[&>div:first-child]:!gap-3 sm:[&>div:first-child]:!gap-3.5 [&_[data-slot=page-header-actions]]:!self-center [&_[data-slot=page-header-row]]:!items-center [&_[data-slot=page-header-row]]:!gap-2 min-[400px]:[&_[data-slot=page-header-row]]:!gap-3 sm:[&_[data-slot=page-header-row]]:!justify-start sm:[&_[data-slot=page-header-row]]:!gap-0 sm:[&_[data-slot=page-header-copy]]:!flex-none sm:[&_[data-slot=page-header-actions]]:!ml-5 sm:[&_[data-slot=page-header-actions]]:!justify-start lg:[&_[data-slot=page-header-row]]:!justify-between lg:[&_[data-slot=page-header-actions]]:!ml-auto lg:[&_[data-slot=page-header-actions]]:!justify-end";

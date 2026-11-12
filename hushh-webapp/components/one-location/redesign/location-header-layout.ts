/**
 * Phone-safe geometry for the Location header's switch and status caption.
 * Kept outside the component so browser layout tests measure the shipped
 * classes instead of a copied approximation.
 */

/**
 * Keep the switch legible without letting it become a detached desktop island.
 *
 * Place the status under the switch, centred on it. The label retains a 44px
 * tap target while the visual track stays compact.
 */
export const LOCATION_HEADER_ACTIONS_CLASSNAME =
  "flex min-h-11 shrink-0 items-center border-r border-border/60 pr-2 sm:pr-3";

export const LOCATION_HEADER_STATUS_CLASSNAME =
  "block max-w-24 whitespace-normal text-center font-[family-name:var(--font-app-body)] ui-text-row-description tracking-[-0.01em] text-[color:var(--app-secondary-label)]";

export const LOCATION_HEADER_TOGGLE_LABEL_CLASSNAME =
  "flex min-h-11 cursor-pointer flex-col items-center justify-center gap-0.5";

/** Reduce the entire track and thumb by 10%, preserving the label's tap target. */
export const LOCATION_HEADER_SWITCH_CLASSNAME =
  "scale-90 shrink-0 data-[size=default]:h-6 data-[size=default]:w-[3.375rem] [&_[data-slot=switch-thumb]]:!size-5 [&_[data-slot=switch-thumb][data-state=checked]]:!translate-x-[1.875rem]";

export const LOCATION_HUB_PAGE_HEADER_CLASSNAME =
  "[&>div:first-child]:!gap-3 sm:[&>div:first-child]:!gap-3.5 [&_[data-slot=page-header-actions]]:!self-center [&_[data-slot=page-header-row]]:!items-center [&_[data-slot=page-header-row]]:!gap-2 min-[400px]:[&_[data-slot=page-header-row]]:!gap-3 sm:[&_[data-slot=page-header-row]]:!justify-start sm:[&_[data-slot=page-header-row]]:!gap-0 sm:[&_[data-slot=page-header-copy]]:!flex-none sm:[&_[data-slot=page-header-actions]]:!ml-5 sm:[&_[data-slot=page-header-actions]]:!justify-start lg:[&_[data-slot=page-header-row]]:!justify-between lg:[&_[data-slot=page-header-actions]]:!ml-auto lg:[&_[data-slot=page-header-actions]]:!justify-end";

/**
 * Phone-safe geometry for the Location header's switch and status caption.
 * Kept outside the component so browser layout tests measure the shipped
 * classes instead of a copied approximation.
 */

export const LOCATION_HEADER_ACTIONS_CLASSNAME =
  "ml-auto flex min-h-[64px] min-w-[104px] max-w-[45vw] shrink-0 flex-col items-center justify-center overflow-visible px-1";

export const LOCATION_HEADER_STATUS_CLASSNAME =
  "mt-1 block max-w-full whitespace-normal text-center font-[family-name:var(--font-app-body)] text-[12px] font-normal leading-4 tracking-[-0.01em] text-[color:var(--app-secondary-label)] [overflow-wrap:anywhere]";

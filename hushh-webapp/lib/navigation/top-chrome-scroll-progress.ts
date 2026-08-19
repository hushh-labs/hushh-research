export const TOP_CHROME_SCROLL_TRAVEL_PX = 84;
export const TOP_CHROME_SCROLL_TOP_RESET_PX = 10;
export const TOP_CHROME_SCROLL_JITTER_PX = 1.5;

/**
 * Fraction of the 0-1 collapse gesture spent fading the brand row's opacity
 * to zero. The row's reserved height (`resolveTopChromeCollapseProgress`)
 * only starts shrinking once the fade has finished, so the box never crops a
 * row that is still visibly opaque — see the two functions below.
 */
export const TOP_CHROME_FADE_FRACTION = 0.5;

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function resolveInitialTopChromeProgress(scrollY: number): number {
  const nextY = Math.max(0, Number.isFinite(scrollY) ? scrollY : 0);
  if (nextY <= TOP_CHROME_SCROLL_TOP_RESET_PX) return 0;
  return clamp01(nextY / TOP_CHROME_SCROLL_TRAVEL_PX);
}

export function resolveTopChromeScrollProgress(input: {
  progress: number;
  previousY: number;
  nextY: number;
}): number {
  const nextY = Math.max(0, Number.isFinite(input.nextY) ? input.nextY : 0);
  if (nextY <= TOP_CHROME_SCROLL_TOP_RESET_PX) return 0;

  const previousY = Math.max(
    0,
    Number.isFinite(input.previousY) ? input.previousY : 0,
  );
  const delta = nextY - previousY;
  if (Math.abs(delta) < TOP_CHROME_SCROLL_JITTER_PX) {
    return clamp01(input.progress);
  }

  // Follow the gesture in both directions. In particular, upward movement
  // must reveal the header while the page is still scrolled, rather than
  // waiting for the primary page heading to return to the viewport.
  return clamp01(input.progress + delta / TOP_CHROME_SCROLL_TRAVEL_PX);
}

/**
 * The brand row's opacity, as its own sub-progress of the collapse gesture:
 * fully visible at `progress = 0`, fully transparent by
 * `TOP_CHROME_FADE_FRACTION`, and staying there for the remainder.
 */
export function resolveTopChromeOpacityProgress(progress: number): number {
  return clamp01(progress / TOP_CHROME_FADE_FRACTION);
}

/**
 * The brand row's height-collapse, as its own sub-progress of the same
 * gesture: holds at 0 (no height lost, nothing to clip) until the opacity
 * above has fully faded, then ramps to 1 by the end of the gesture.
 */
export function resolveTopChromeCollapseProgress(progress: number): number {
  return clamp01(
    (progress - TOP_CHROME_FADE_FRACTION) / (1 - TOP_CHROME_FADE_FRACTION),
  );
}

/**
 * The brand row's collapse geometry, exported so a layout-contract test can
 * assert against the exact formula that ships rather than a hand-copied
 * duplicate. Consumed by `components/app-ui/top-app-bar.tsx`, which writes
 * `--top-chrome-collapse-px` and `--top-chrome-progress` from
 * `resolveTopChromeCollapseProgress` / `resolveTopChromeOpacityProgress`
 * above — never letting one imply the other is safe to ignore.
 */
export const TOP_CHROME_ROW_MAX_HEIGHT_CSS =
  "calc(var(--top-inset) + var(--top-systembar-row-gap) + var(--top-bar-h) - var(--top-chrome-collapse-px, 0px))";
export const TOP_CHROME_ROW_OPACITY_CSS =
  "calc(1 - var(--top-chrome-progress, 0))";

export const TOP_CHROME_SCROLL_TRAVEL_PX = 84;
export const TOP_CHROME_SCROLL_TOP_RESET_PX = 10;
export const TOP_CHROME_SCROLL_JITTER_PX = 1.5;

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

import { describe, expect, it } from "vitest";
import {
  resolveInitialTopChromeProgress,
  resolveTopChromeCollapseProgress,
  resolveTopChromeOpacityProgress,
  resolveTopChromeScrollProgress,
  TOP_CHROME_FADE_FRACTION,
} from "@/lib/navigation/top-chrome-scroll-progress";

describe("top chrome scroll progress", () => {
  it("collapses in direct proportion to a downward gesture", () => {
    expect(
      resolveTopChromeScrollProgress({
        progress: 0,
        previousY: 20,
        nextY: 62,
      }),
    ).toBe(0.5);
  });

  it("begins restoring immediately on an upward gesture while mid-page", () => {
    expect(
      resolveTopChromeScrollProgress({
        progress: 1,
        previousY: 600,
        nextY: 558,
      }),
    ).toBe(0.5);
  });

  it("fully restores near the top and ignores sub-pixel scroll jitter", () => {
    expect(
      resolveTopChromeScrollProgress({
        progress: 1,
        previousY: 20,
        nextY: 10,
      }),
    ).toBe(0);
    expect(
      resolveTopChromeScrollProgress({
        progress: 0.4,
        previousY: 120,
        nextY: 121,
      }),
    ).toBe(0.4);
  });

  it("seeds restored routes from their current scroll position", () => {
    expect(resolveInitialTopChromeProgress(0)).toBe(0);
    expect(resolveInitialTopChromeProgress(42)).toBe(0.5);
    expect(resolveInitialTopChromeProgress(200)).toBe(1);
  });
});

describe("top chrome fade/collapse split", () => {
  // The regression this guards: opacity and the row's reserved height used
  // to be driven off the same raw progress, so for most of the gesture the
  // brand row was still visibly opaque while `overflow: hidden` was already
  // cropping its bottom edge. Nothing may ever be both visible and clipped.
  it("never lets the row lose height while it is still visible", () => {
    for (let progress = 0; progress <= 1; progress += 0.01) {
      const opacityProgress = resolveTopChromeOpacityProgress(progress);
      const collapseProgress = resolveTopChromeCollapseProgress(progress);
      const isVisible = opacityProgress < 1; // opacity = 1 - opacityProgress
      if (isVisible) {
        expect(collapseProgress).toBe(0);
      }
    }
  });

  it("fades out completely by the fade fraction, then holds", () => {
    expect(resolveTopChromeOpacityProgress(0)).toBe(0);
    expect(resolveTopChromeOpacityProgress(TOP_CHROME_FADE_FRACTION / 2)).toBe(
      0.5,
    );
    expect(resolveTopChromeOpacityProgress(TOP_CHROME_FADE_FRACTION)).toBe(1);
    expect(resolveTopChromeOpacityProgress(1)).toBe(1);
  });

  it("holds the box at full height until the fade finishes, then collapses to the end", () => {
    expect(resolveTopChromeCollapseProgress(0)).toBe(0);
    expect(resolveTopChromeCollapseProgress(TOP_CHROME_FADE_FRACTION)).toBe(0);
    expect(
      resolveTopChromeCollapseProgress(
        TOP_CHROME_FADE_FRACTION + (1 - TOP_CHROME_FADE_FRACTION) / 2,
      ),
    ).toBe(0.5);
    expect(resolveTopChromeCollapseProgress(1)).toBe(1);
  });

  it("both curves finish together at the end of the gesture", () => {
    expect(resolveTopChromeOpacityProgress(1)).toBe(1);
    expect(resolveTopChromeCollapseProgress(1)).toBe(1);
  });
});

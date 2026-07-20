import { describe, expect, it } from "vitest";
import {
  resolveInitialTopChromeProgress,
  resolveTopChromeScrollProgress,
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

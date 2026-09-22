import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AMBIENT_CHROME_FULL_BLEED_ATTR,
  AMBIENT_CHROME_IGNORE_ATTR,
  AMBIENT_CHROME_MASK_ATTR,
  AMBIENT_CHROME_TOP_SURFACE_ATTR,
  AmbientColorSpring,
  createAmbientChromeEngine,
  requestAmbientChromeSample,
  parseCssColor,
  parseCssRgb,
  parseGradientSurface,
} from "@/lib/morphy-ux/ambient-chrome";

describe("ambient chrome", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute(AMBIENT_CHROME_TOP_SURFACE_ATTR);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("parses opaque solid surfaces and averages gradient stops", () => {
    expect(parseCssRgb("rgb(12 34 56 / 1)")).toEqual([12, 34, 56]);
    expect(parseCssRgb("rgba(12, 34, 56, 0.4)")).toBeNull();
    expect(parseCssColor("oklch(0.971 0.003 286.4)")).not.toBeNull();
    expect(parseCssColor("lab(96.61 0.299901 -1.091)")).not.toBeNull();
    expect(
      parseGradientSurface(
        "linear-gradient(90deg, rgb(0, 0, 0), rgba(255, 255, 255, 1))",
      ),
    ).toEqual([128, 128, 128]);
  });

  it("primes from painted content while excluding chrome and selecting contrast", () => {
    const mask = document.createElement("div");
    mask.setAttribute(AMBIENT_CHROME_MASK_ATTR, "top");
    mask.getBoundingClientRect = () =>
      ({ top: 0, bottom: 80, height: 80, width: 2000 }) as DOMRect;
    document.body.append(mask);

    const chrome = document.createElement("div");
    chrome.setAttribute(AMBIENT_CHROME_IGNORE_ATTR, "");
    chrome.style.backgroundColor = "rgb(245, 245, 247)";
    document.body.append(chrome);

    const overlay = document.createElement("div");
    overlay.setAttribute("data-slot", "dialog-overlay");
    overlay.style.backgroundColor = "rgb(245, 245, 247)";
    document.body.append(overlay);

    const darkSurface = document.createElement("main");
    darkSurface.style.backgroundColor = "rgb(18, 24, 36)";
    darkSurface.getBoundingClientRect = () =>
      ({ top: 0, bottom: 800, height: 800, width: 2000 }) as DOMRect;
    document.body.append(darkSurface);

    const scrollRoot = document.createElement("div");
    scrollRoot.setAttribute("data-app-scroll-root", "true");
    document.body.append(scrollRoot);

    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [chrome, overlay, darkSurface]),
    });
    vi.useFakeTimers();
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockReturnValue(0);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const stop = createAmbientChromeEngine();

    expect(
      mask.style.getPropertyValue("--ambient-chrome-top-bg"),
    ).toBe("rgb(18, 24, 36)");
    expect(
      mask.style.getPropertyValue("--ambient-chrome-top-fg"),
    ).toBe("#f5f5f7");
    expect(
      document.documentElement.getAttribute(AMBIENT_CHROME_TOP_SURFACE_ATTR),
    ).toBe("dark");
    requestAnimationFrame.mockClear();
    scrollRoot.dispatchEvent(new Event("scroll"));
    // A scroll never samples in its own frame: the sampler does forced
    // layout reads. It arms an idle timer and samples once after it.
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    stop();
    expect(
      document.documentElement.hasAttribute(AMBIENT_CHROME_TOP_SURFACE_ATTR),
    ).toBe(false);
  });

  it("uses the Foundation canvas before the document fallback", () => {
    const mask = document.createElement("div");
    mask.setAttribute(AMBIENT_CHROME_MASK_ATTR, "bottom");
    mask.getBoundingClientRect = () =>
      ({ top: 700, bottom: 800, height: 100, width: 2000 }) as DOMRect;
    document.body.append(mask);

    const foundation = document.createElement("div");
    foundation.setAttribute("data-foundation-canvas", "true");
    foundation.style.backgroundColor = "lab(34 4 -20)";
    document.body.append(foundation);

    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [document.body]),
    });
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const stop = createAmbientChromeEngine();
    expect(
      mask.style.getPropertyValue("--ambient-chrome-bottom-bg"),
    ).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    stop();
  });

  it("uses the live painted surface and matching contrast for the bottom dock", () => {
    const mask = document.createElement("div");
    mask.setAttribute(AMBIENT_CHROME_MASK_ATTR, "bottom");
    mask.getBoundingClientRect = () =>
      ({ top: 700, bottom: 800, height: 100, width: 2000 }) as DOMRect;
    document.body.append(mask);

    const fullBleedSurface = document.createElement("main");
    fullBleedSurface.setAttribute(AMBIENT_CHROME_FULL_BLEED_ATTR, "");
    fullBleedSurface.style.backgroundColor = "rgb(80, 90, 100)";
    fullBleedSurface.getBoundingClientRect = () =>
      ({ top: 0, bottom: 800, height: 800, width: 2000 }) as DOMRect;
    document.body.append(fullBleedSurface);

    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [fullBleedSurface]),
    });
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const stop = createAmbientChromeEngine();
    expect(
      mask.style.getPropertyValue("--ambient-chrome-bottom-bg"),
    ).toBe("rgb(80, 90, 100)");
    expect(
      mask.style.getPropertyValue("--ambient-chrome-bottom-fg"),
    ).toBe("#f5f5f7");
    stop();
  });

  it("never writes custom properties on <html> and never observes the body subtree", () => {
    const mask = document.createElement("div");
    mask.setAttribute(AMBIENT_CHROME_MASK_ATTR, "top");
    mask.getBoundingClientRect = () =>
      ({ top: 0, bottom: 80, height: 80, width: 2000 }) as DOMRect;
    document.body.append(mask);
    const surface = document.createElement("main");
    surface.setAttribute(AMBIENT_CHROME_FULL_BLEED_ATTR, "");
    surface.style.backgroundColor = "rgb(18, 24, 36)";
    surface.getBoundingClientRect = () =>
      ({ top: 0, bottom: 800, height: 800, width: 2000 }) as DOMRect;
    document.body.append(surface);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [surface]),
    });
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const rootSetProperty = vi.spyOn(
      document.documentElement.style,
      "setProperty",
    );
    const observed: Array<{ target: Node; options?: MutationObserverInit }> = [];
    const observe = MutationObserver.prototype.observe;
    vi.spyOn(MutationObserver.prototype, "observe").mockImplementation(
      function (this: MutationObserver, target: Node, options?: MutationObserverInit) {
        observed.push({ target, options });
        return observe.call(this, target, options);
      },
    );

    const stop = createAmbientChromeEngine();

    // The sampled colour lands on the mask; a custom-property write on <html>
    // invalidates style for the whole document.
    expect(rootSetProperty).not.toHaveBeenCalled();
    expect(mask.style.getPropertyValue("--ambient-chrome-top-bg")).toBe(
      "rgb(18, 24, 36)",
    );
    // Only the theme class on <html> is observed; a body-wide subtree
    // observer woke the sampler on every DOM mutation in the app.
    expect(observed).toHaveLength(1);
    expect(observed[0].target).toBe(document.documentElement);
    expect(observed[0].options?.subtree).not.toBe(true);
    expect(observed[0].options?.attributeFilter).toEqual(["class"]);
    stop();
  });

  it("re-samples when the controller reports a route settle", () => {
    const mask = document.createElement("div");
    mask.setAttribute(AMBIENT_CHROME_MASK_ATTR, "top");
    mask.getBoundingClientRect = () =>
      ({ top: 0, bottom: 80, height: 80, width: 2000 }) as DOMRect;
    document.body.append(mask);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [document.body]),
    });
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockReturnValue(0);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    vi.useFakeTimers();
    const stop = createAmbientChromeEngine();
    requestAnimationFrame.mockClear();
    requestAmbientChromeSample();
    // A route settle samples after the enter beat, not on the frame the
    // incoming page takes its first layout and paint.
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    stop();
    requestAnimationFrame.mockClear();
    // Once stopped, a settle request is a no-op rather than a leak.
    requestAmbientChromeSample();
    vi.advanceTimersByTime(300);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("settles a bounded, non-overshooting OKLCH spring", () => {
    const spring = new AmbientColorSpring();
    spring.setTarget([30, 30, 30], true);
    spring.setTarget([230, 230, 230]);

    // White <-> dark changes are intentionally animated. Only first paint or
    // reduced motion may snap, matching the shared Search Console contract.
    const firstTransitionFrame = spring.step(16);
    expect(firstTransitionFrame).not.toBeNull();
    expect(firstTransitionFrame![0]).toBeGreaterThan(30);
    expect(firstTransitionFrame![0]).toBeLessThan(230);

    for (let frame = 0; frame < 180; frame += 1) {
      const color = spring.step(16);
      expect(color).not.toBeNull();
      expect(color!.every((channel) => channel >= 0 && channel <= 255)).toBe(
        true,
      );
      expect(color!.every((channel) => channel <= 230)).toBe(true);
    }

    expect(spring.settled).toBe(true);
  });

  it("accepts a declared full-bleed surface before falling back to a scaffold", () => {
    const mask = document.createElement("div");
    mask.setAttribute(AMBIENT_CHROME_MASK_ATTR, "top");
    mask.getBoundingClientRect = () =>
      ({ top: 0, bottom: 80, height: 80, width: window.innerWidth }) as DOMRect;
    document.body.append(mask);

    const surface = document.createElement("main");
    surface.setAttribute(AMBIENT_CHROME_FULL_BLEED_ATTR, "");
    surface.style.backgroundColor = "rgb(18, 24, 36)";
    surface.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: window.innerHeight,
        height: window.innerHeight,
        width: window.innerWidth,
      }) as DOMRect;
    document.body.append(surface);

    const elementsFromPoint = vi.fn(() => [surface]);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: elementsFromPoint,
    });
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const stop = createAmbientChromeEngine();

    expect(
      mask.style.getPropertyValue("--ambient-chrome-top-bg"),
    ).toBe("rgb(18, 24, 36)");
    expect(elementsFromPoint).toHaveBeenCalledTimes(1);
    stop();
  });
});

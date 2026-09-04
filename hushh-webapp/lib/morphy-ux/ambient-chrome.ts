export type AmbientChromeEdge = "top" | "bottom";
export type Rgb = [number, number, number];
type Oklch = [number, number, number];

export const AMBIENT_CHROME_MASK_ATTR = "data-ambient-chrome-mask";
export const AMBIENT_CHROME_IGNORE_ATTR = "data-ambient-chrome-ignore";
/** Marks a real full-viewport painted route surface, never a neutral scaffold. */
export const AMBIENT_CHROME_FULL_BLEED_ATTR = "data-ambient-full-bleed";
/** Publishes whether the surface directly beneath the top chrome is dark or light. */
export const AMBIENT_CHROME_TOP_SURFACE_ATTR =
  "data-ambient-chrome-top-surface";
export type AmbientChromeSurfaceTone = "dark" | "light";
/** Keep the foreground, wordmark, and native system-bar contrast decision aligned. */
export const AMBIENT_CHROME_DARK_LIGHTNESS_THRESHOLD = 0.55;

const TRANSIENT_OVERLAY_SELECTOR = [
  `[${AMBIENT_CHROME_IGNORE_ATTR}]`,
  '[data-slot="dialog-overlay"]',
  '[data-slot="alert-dialog-overlay"]',
  "[data-radix-popper-content-wrapper]",
  '[role="dialog"]',
].join(", ");

export const AMBIENT_CHROME_VARS = {
  top: {
    background: "--ambient-chrome-top-bg",
    foreground: "--ambient-chrome-top-fg",
  },
  bottom: {
    background: "--ambient-chrome-bottom-bg",
    foreground: "--ambient-chrome-bottom-fg",
  },
} as const;

export function resolveAmbientChromeSurfaceTone(
  lightness: number | null,
): AmbientChromeSurfaceTone {
  return (lightness ?? 1) < AMBIENT_CHROME_DARK_LIGHTNESS_THRESHOLD
    ? "dark"
    : "light";
}

export function ambientChromeMaskAttr(edge: AmbientChromeEdge) {
  return { [AMBIENT_CHROME_MASK_ATTR]: edge } as const;
}

/** Use this on a route-owned full-bleed surface that intentionally paints below chrome. */
export function ambientChromeFullBleedAttr() {
  return { [AMBIENT_CHROME_FULL_BLEED_ATTR]: "" } as const;
}

export function parseCssRgb(value: string): Rgb | null {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match?.[1]) return null;
  const values = match[1]
    .trim()
    .replace(/\s*\/\s*/, " ")
    .split(/[\s,]+/);
  const [r, g, b] = values
    .slice(0, 3)
    .map((part) => Number.parseFloat(part.trim()));
  const alpha = values[3] ? parseCssAlpha(values[3]) : 1;
  if (
    r === undefined ||
    g === undefined ||
    b === undefined ||
    ![r, g, b].every(Number.isFinite) ||
    alpha < 0.7
  ) {
    return null;
  }
  return [r, g, b];
}

function parseCssAlpha(value: string | undefined): number {
  const raw = String(value ?? "").trim();
  const parsed = Number.parseFloat(raw);
  return raw.endsWith("%") ? parsed / 100 : parsed;
}

function parseCssOklch(value: string): Rgb | null {
  const match = value.match(/oklch\(([^)]+)\)/i);
  if (!match?.[1]) return null;
  const values = match[1]
    .trim()
    .replace(/\s*\/\s*/, " ")
    .split(/\s+/)
    .map((part) => Number.parseFloat(part.replace("%", "")));
  const [rawLightness, chroma, hue] = values;
  const alpha = match[1].includes("/")
    ? parseCssAlpha(match[1].split("/")[1])
    : 1;
  if (
    rawLightness === undefined ||
    chroma === undefined ||
    hue === undefined ||
    ![rawLightness, chroma, hue, alpha].every(Number.isFinite) ||
    alpha < 0.7
  ) {
    return null;
  }
  const lightness = rawLightness > 1 ? rawLightness / 100 : rawLightness;
  if (lightness < 0 || lightness > 1) return null;
  return oklchToRgb([lightness, chroma, hue]);
}

function parseCssOklab(value: string): Rgb | null {
  const match = value.match(/oklab\(([^)]+)\)/i);
  if (!match?.[1]) return null;
  const [channels = "", alphaValue] = match[1].trim().split(/\s*\/\s*/, 2);
  const values = channels
    .split(/\s+/)
    .map((part) => Number.parseFloat(part.replace("%", "")));
  const alpha = alphaValue ? parseCssAlpha(alphaValue) : 1;
  const [lightness, a, b] = values;
  if (
    lightness === undefined ||
    a === undefined ||
    b === undefined ||
    ![lightness, a, b, alpha].every(Number.isFinite) ||
    alpha < 0.7
  ) {
    return null;
  }
  const chroma = Math.hypot(a, b);
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  return oklchToRgb([
    lightness > 1 ? lightness / 100 : lightness,
    chroma,
    hue < 0 ? hue + 360 : hue,
  ]);
}

function parseCssLab(value: string): Rgb | null {
  const match = value.match(/(?<!ok)lab\(([^)]+)\)/i);
  if (!match?.[1]) return null;
  const [channels = "", alphaValue] = match[1].trim().split(/\s*\/\s*/, 2);
  const values = channels
    .split(/\s+/)
    .map((part) => Number.parseFloat(part.replace("%", "")));
  const alpha = alphaValue ? parseCssAlpha(alphaValue) : 1;
  const [lightness, a, b] = values;
  if (
    lightness === undefined ||
    a === undefined ||
    b === undefined ||
    ![lightness, a, b, alpha].every(Number.isFinite) ||
    alpha < 0.7
  ) {
    return null;
  }
  const fy = (lightness + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const epsilon = 216 / 24_389;
  const kappa = 24_389 / 27;
  const linear = (channel: number) => {
    const cubed = channel ** 3;
    return cubed > epsilon ? cubed : (116 * channel - 16) / kappa;
  };
  // CSS `lab()` is D50. Adapt to D65 before converting to sRGB.
  const x50 = linear(fx) * 0.96422;
  const y50 = linear(fy);
  const z50 = linear(fz) * 0.82521;
  const x = 0.9555766 * x50 - 0.0230393 * y50 + 0.0631636 * z50;
  const y = -0.0282895 * x50 + 1.0099416 * y50 + 0.0210077 * z50;
  const z = 0.0122982 * x50 - 0.020483 * y50 + 1.3299098 * z50;
  return [
    toSrgb(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    toSrgb(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    toSrgb(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ];
}

/** Parses computed CSS colors emitted by the Foundation theme. */
export function parseCssColor(value: string): Rgb | null {
  return (
    parseCssRgb(value) ??
    parseCssOklch(value) ??
    parseCssOklab(value) ??
    parseCssLab(value)
  );
}

export function parseGradientSurface(value: string): Rgb | null {
  if (!value.includes("gradient(") || value.includes("url(")) return null;
  const colors = value.match(/(?:rgba?|oklch|oklab|lab)\([^)]+\)/gi) ?? [];
  const parsed = colors
    .map(parseCssColor)
    .filter((color): color is Rgb => color !== null);
  if (!parsed.length) return null;
  return parsed
    .reduce<Rgb>(
      (total, color) => [
        total[0] + color[0],
        total[1] + color[1],
        total[2] + color[2],
      ],
      [0, 0, 0],
    )
    .map((channel) => Math.round(channel / parsed.length)) as Rgb;
}

function toLinear(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function toSrgb(value: number): number {
  const normalized =
    value <= 0.0031308
      ? value * 12.92
      : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, normalized)) * 255);
}

function rgbToOklch([r, g, b]: Rgb): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(a, bb);
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return [lightness, chroma, hue < 0 ? hue + 360 : hue];
}

function oklchToRgb([lightness, chroma, hue]: Oklch): Rgb {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const bb = chroma * Math.sin(radians);
  const l = Math.pow(lightness + 0.3963377774 * a + 0.2158037573 * bb, 3);
  const m = Math.pow(lightness - 0.1055613458 * a - 0.0638541728 * bb, 3);
  const s = Math.pow(lightness - 0.0894841775 * a - 1.291485548 * bb, 3);
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function hueDelta(current: number, target: number): number {
  let delta = (target - current) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

export class AmbientColorSpring {
  private current: Oklch | null = null;
  private target: Oklch | null = null;
  private velocity: Oklch = [0, 0, 0];

  setTarget(value: Rgb, snap = false) {
    const next = rgbToOklch(value);
    // Match the Search Console material contract: only an explicit first-paint
    // or reduced-motion request snaps. OKLCH lightness is 0..1, so the 2.0
    // guard deliberately keeps even white <-> dark transitions spring-driven.
    if (snap || !this.current || Math.abs(next[0] - this.current[0]) > 2) {
      this.current = next;
      this.target = next;
      this.velocity = [0, 0, 0];
      return;
    }
    this.target = next;
  }

  step(deltaMs: number): Rgb | null {
    if (!this.current || !this.target)
      return this.current ? oklchToRgb(this.current) : null;
    const dt = Math.min(deltaMs / 1000, 0.064);
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    for (let index = 0; index < steps; index += 1) {
      const step = dt / steps;
      const deltas: Oklch = [
        this.target[0] - this.current[0],
        this.target[1] - this.current[1],
        hueDelta(this.current[2], this.target[2]),
      ];
      for (let channel = 0; channel < 3; channel += 1) {
        const index = channel as 0 | 1 | 2;
        const acceleration = 210 * deltas[index] - 30 * this.velocity[index];
        this.velocity[index] += acceleration * step;
        this.current[index] += this.velocity[index] * step;
      }
      this.current[0] = Math.max(0, Math.min(1, this.current[0]));
      this.current[1] = Math.max(0, this.current[1]);
      this.current[2] = (this.current[2] + 360) % 360;
    }
    return oklchToRgb(this.current);
  }

  get settled(): boolean {
    if (!this.current || !this.target) return true;
    return (
      Math.abs(this.current[0] - this.target[0]) < 0.001 &&
      Math.abs(this.current[1] - this.target[1]) < 0.001 &&
      Math.abs(hueDelta(this.current[2], this.target[2])) * this.current[1] <
        0.2
    );
  }

  get lightness(): number | null {
    return this.current?.[0] ?? null;
  }
}

const AMBIENT_SAMPLE_COLUMNS: Record<
  AmbientChromeEdge,
  (width: number) => number[]
> = {
  // Match the Search Console contract: start at the visual centre, then cover
  // the primary content columns. A card or gap can no longer choose the tint.
  top: (width) => [
    width / 2,
    width * 0.35,
    width * 0.65,
    width * 0.2,
    width * 0.8,
  ],
  bottom: (width) => [width * 0.2, width * 0.8, width / 2, width * 0.4],
};
const AMBIENT_SAMPLE_GAP = 6;
const AMBIENT_SAMPLE_DEPTH = 34;
const AMBIENT_SAMPLE_COUNT = 5;
const AMBIENT_MIN_SURFACE_WIDTH = 0.6;
// Sampling calls elementsFromPoint, computed style, and layout reads. Keep
// the visual spring at frame rate, but cap expensive surface discovery while
// a native scroll gesture is active.
const AMBIENT_SCROLL_SAMPLE_INTERVAL_MS = 96;
const AMBIENT_SCROLL_SAMPLE_DISTANCE_PX = 24;
const AMBIENT_SCROLL_IDLE_RESAMPLE_MS = 120;

/**
 * Resolve one real surface at a probe point. The long-lived app scaffold is a
 * fallback, never the first answer: a full-height wrapper frequently paints a
 * neutral canvas behind a shorter, meaningful route surface.
 */
function surfaceAt(x: number, y: number, skipScaffold = false): Rgb | null {
  if (
    typeof document === "undefined" ||
    typeof document.elementsFromPoint !== "function"
  )
    return null;
  const viewportWidth = window.innerWidth || 1;
  const viewportHeight = window.innerHeight || 1;
  let documentFallback: Rgb | null = null;
  let firstSolid: Rgb | null = null;
  for (const hit of document.elementsFromPoint(x, y)) {
    if (hit.closest(TRANSIENT_OVERLAY_SELECTOR)) continue;
    let node: Element | null = hit;
    while (node) {
      if (node.closest(TRANSIENT_OVERLAY_SELECTOR)) break;
      const style = getComputedStyle(node);
      const color =
        parseCssColor(style.backgroundColor) ??
        parseGradientSurface(style.backgroundImage);
      const isDocumentPaint =
        node === document.body || node === document.documentElement;
      if (color && isDocumentPaint) {
        // The body is a theme fallback, not route paint. Prefer the shared
        // Foundation canvas below so a mobile WebKit fallback cannot turn a
        // translucent route into a black/grey chrome band.
        documentFallback ??= color;
      } else if (color) {
        firstSolid ??= color;
        const rect = node.getBoundingClientRect();
        if (rect.width >= viewportWidth * AMBIENT_MIN_SURFACE_WIDTH) {
          const isScaffold =
            rect.height >= viewportHeight - 1 &&
            !node.hasAttribute(AMBIENT_CHROME_FULL_BLEED_ATTR);
          if (!isScaffold || !skipScaffold) return color;
        }
      }
      node = node.parentElement;
    }
  }
  // During the real-surface pass, returning a neutral fallback early would
  // prevent another column or a deeper probe from finding the painted band.
  if (skipScaffold) return null;
  const foundation = document.querySelector("[data-foundation-canvas='true']");
  if (foundation) {
    const style = getComputedStyle(foundation);
    const color =
      parseCssColor(style.backgroundColor) ??
      parseGradientSurface(style.backgroundImage);
    if (color) return color;
  }
  return firstSolid ?? documentFallback;
}

function sampleSurfaceAtDepth(
  columns: number[],
  y: number,
  skipScaffold: boolean,
): Rgb | null {
  for (const x of columns) {
    const color = surfaceAt(x, y, skipScaffold);
    if (color) return color;
  }
  return null;
}

/**
 * Search Console's position-aware rule: sample from the opaque part of the
 * mask toward its content edge and take the first actual surface. This avoids
 * muddy averages and prevents a card, gap, or tab fade from deciding the tint.
 */
function sampleSurfaceAcrossMask(
  columns: number[],
  contentY: number,
  solidY: number,
): Rgb | null {
  const depths = Array.from(
    { length: AMBIENT_SAMPLE_COUNT },
    (_, index) =>
      solidY + ((contentY - solidY) * index) / (AMBIENT_SAMPLE_COUNT - 1),
  );
  for (const y of depths) {
    const color = sampleSurfaceAtDepth(columns, y, true);
    if (color) return color;
  }
  for (const y of depths) {
    const color = sampleSurfaceAtDepth(columns, y, false);
    if (color) return color;
  }
  return null;
}

function sampleMask(mask: Element, edge: AmbientChromeEdge): Rgb | null {
  const rect = mask.getBoundingClientRect();
  if (rect.height <= 0 || getComputedStyle(mask).display === "none")
    return null;
  const viewportHeight = window.innerHeight || 1;
  const contentEdge = edge === "top" ? rect.bottom : rect.top;
  const direction = edge === "top" ? 1 : -1;
  const clampY = (value: number) =>
    Math.max(0, Math.min(viewportHeight - 1, value));
  const contentY = clampY(contentEdge + direction * AMBIENT_SAMPLE_GAP);
  // The solid probe is anchored at the viewport edge, never the moving mask
  // edge. This is the key Search Console behaviour: the tint represents the
  // actual surface underneath opaque chrome, while the fade only reveals it.
  const solidY = clampY(
    edge === "top"
      ? AMBIENT_SAMPLE_DEPTH
      : viewportHeight - AMBIENT_SAMPLE_DEPTH,
  );
  return sampleSurfaceAcrossMask(
    AMBIENT_SAMPLE_COLUMNS[edge](window.innerWidth || 1),
    contentY,
    solidY,
  );
}

export function createAmbientChromeEngine(enabled = true): () => void {
  if (!enabled || typeof window === "undefined") return () => {};
  const root = document.documentElement;
  const springs = new Map<AmbientChromeEdge, AmbientColorSpring>();
  let frame = 0;
  let lastFrame = 0;
  let lastActivity = 0;
  let scrollRoot: Element | null = null;
  let lastSampleAt = 0;
  let lastSampleScrollY = 0;
  let sampleRequested = true;
  let lastOnScreen = false;
  let scrollIdleTimer: number | null = null;

  const setRootVariable = (name: string, value: string) => {
    if (root.style.getPropertyValue(name) !== value) {
      root.style.setProperty(name, value);
    }
  };
  const readScrollY = () => {
    if (scrollRoot instanceof HTMLElement) {
      return Math.max(0, scrollRoot.scrollTop || 0);
    }
    return Math.max(0, window.scrollY || window.pageYOffset || 0);
  };

  const write = (
    edge: AmbientChromeEdge,
    color: Rgb,
    lightness: number | null,
  ) => {
    const vars = AMBIENT_CHROME_VARS[edge];
    const tone = resolveAmbientChromeSurfaceTone(lightness);
    setRootVariable(vars.background, `rgb(${color.join(", ")})`);
    setRootVariable(vars.foreground, tone === "dark" ? "#f5f5f7" : "#1d1d1f");
    if (
      edge === "top" &&
      root.getAttribute(AMBIENT_CHROME_TOP_SURFACE_ATTR) !== tone
    ) {
      root.setAttribute(AMBIENT_CHROME_TOP_SURFACE_ATTR, tone);
    }
    root.dataset.ambientChromePrimed = "true";
  };
  const sampleTargets = (snap = false) => {
    const masks = Array.from(
      document.querySelectorAll(`[${AMBIENT_CHROME_MASK_ATTR}]`),
    );
    let onScreen = false;
    for (const mask of masks) {
      const edge = mask.getAttribute(
        AMBIENT_CHROME_MASK_ATTR,
      ) as AmbientChromeEdge | null;
      if (edge !== "top" && edge !== "bottom") continue;
      const sampled = sampleMask(mask, edge);
      if (!sampled) continue;
      onScreen = true;
      const spring = springs.get(edge) ?? new AmbientColorSpring();
      springs.set(edge, spring);
      spring.setTarget(
        sampled,
        snap || window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
    }
    return onScreen;
  };
  const tick = (time: number) => {
    const scrollY = readScrollY();
    const shouldSample =
      sampleRequested ||
      (!lastSampleAt && !lastOnScreen) ||
      (time - lastSampleAt >= AMBIENT_SCROLL_SAMPLE_INTERVAL_MS &&
        Math.abs(scrollY - lastSampleScrollY) >=
          AMBIENT_SCROLL_SAMPLE_DISTANCE_PX);
    let sampledThisFrame = false;
    if (shouldSample) {
      lastOnScreen = sampleTargets(false);
      lastSampleAt = time;
      lastSampleScrollY = scrollY;
      sampleRequested = false;
      sampledThisFrame = true;
    }
    let moving = false;
    for (const [edge, spring] of springs) {
      const wasMoving = !spring.settled;
      const color = spring.step(lastFrame ? time - lastFrame : 16);
      const isMoving = !spring.settled;
      if (color && (sampledThisFrame || wasMoving || isMoving)) {
        write(edge, color, spring.lightness);
      }
      moving ||= isMoving;
    }
    lastFrame = time;
    if (
      lastOnScreen &&
      (moving || time - lastActivity < 240 || sampleRequested)
    ) {
      frame = window.requestAnimationFrame(tick);
      return;
    }
    frame = 0;
    lastFrame = 0;
  };
  const wakeWithSampling = (requestSample: boolean) => {
    sampleRequested ||= requestSample;
    lastActivity = performance.now();
    if (!frame) frame = window.requestAnimationFrame(tick);
  };
  const wake = () => wakeWithSampling(true);
  const wakeFromScroll = () => {
    wakeWithSampling(false);
    if (scrollIdleTimer !== null) window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = window.setTimeout(() => {
      scrollIdleTimer = null;
      wake();
    }, AMBIENT_SCROLL_IDLE_RESAMPLE_MS);
  };
  const bindScrollRoot = () => {
    const next = document.querySelector('[data-app-scroll-root="true"]');
    if (next === scrollRoot) return;
    scrollRoot?.removeEventListener("scroll", wakeFromScroll);
    scrollRoot = next;
    scrollRoot?.addEventListener("scroll", wakeFromScroll, { passive: true });
  };
  bindScrollRoot();
  // Prime across several layout frames. Route content often arrives after the
  // shell, so snapping these samples prevents the white/default flash that a
  // spring from a stale first frame would otherwise create.
  let primeFrames = 0;
  const prime = () => {
    sampleTargets(true);
    lastSampleAt = performance.now();
    lastSampleScrollY = readScrollY();
    sampleRequested = false;
    lastOnScreen = springs.size > 0;
    for (const [edge, spring] of springs) {
      const color = spring.step(0);
      if (color) write(edge, color, spring.lightness);
    }
    if (primeFrames++ < 8) window.requestAnimationFrame(prime);
  };
  prime();
  wake();
  // Capture phase also observes the document scroll path on desktop and any
  // route that swaps its scroll root after the shell first mounts.
  window.addEventListener("scroll", wakeFromScroll, {
    passive: true,
    capture: true,
  });
  window.addEventListener("resize", wake, { passive: true });
  const observer = new MutationObserver(() => {
    bindScrollRoot();
    wake();
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "style", "data-state"],
    childList: true,
    subtree: true,
  });
  // next-themes switches the resolved theme on <html>. Watch that class
  // separately: observing body never sees an ancestor mutation, and watching
  // root style would loop on the inline tint tokens this engine writes.
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  return () => {
    scrollRoot?.removeEventListener("scroll", wakeFromScroll);
    window.removeEventListener("scroll", wakeFromScroll, { capture: true });
    window.removeEventListener("resize", wake);
    observer.disconnect();
    if (frame) window.cancelAnimationFrame(frame);
    if (scrollIdleTimer !== null) window.clearTimeout(scrollIdleTimer);
    root.removeAttribute(AMBIENT_CHROME_TOP_SURFACE_ATTR);
  };
}

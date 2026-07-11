// components/onboarding/OnboardingHeroBackground.tsx
// The living backdrop shared by the pre-auth onboarding surfaces (welcome "/",
// sign-in "/login", carousel). Linear/Vercel-grade cinematic canvas: a deep,
// quiet base; a breathing gold + violet mesh; one large soft glow behind the
// hero; a fine film grain; and a whisper of drifting motes.
//
// WHY A <canvas> AND NOT DOM/CSS LAYERS: these screens put liquidglass
// (@ybouane/liquidglass) surfaces on top of this backdrop. The engine has two
// capture paths: <canvas>/<img>/<video> children are composed via a fast,
// synchronous ctx.drawImage EVERY frame, while any other DOM child must be
// rasterised through html-to-image (style inlining + SVG foreignObject +
// async decode). A full-screen animated DOM tree marked data-dynamic forces
// that slow async path per frame, so the glass refracts stale, late captures
// and theme flips lag by hundreds of ms. Painting the backdrop into a canvas
// is the engine's native fast lane (this is how the library's own demo feeds
// animated backgrounds): the glass genuinely refracts the live frame, theme
// toggles repaint on the very next frame, and the per-frame html-to-image /
// foreignObject dependency disappears entirely, which is also the safest
// path for iOS Capacitor WKWebView.
//
// data-dynamic on the canvas tells the engine it changes every frame (only
// <video> is auto-dynamic). Under prefers-reduced-motion the attribute is
// removed and a single static frame is painted instead.

"use client";

import { useEffect, useRef } from "react";

// Deterministic motes so every mount renders the same field. Sparse, slow.
const MOTES = Array.from({ length: 9 }, (_, i) => {
  const seed = (i * 9301 + 49297) % 233280;
  const r = seed / 233280;
  const r2 = ((i * 4021 + 12345) % 233280) / 233280;
  return {
    x: 0.08 + r * 0.84,
    y: 0.1 + r2 * 0.78,
    size: 1.5 + r2 * 2,
    period: 9 + r * 9, // seconds per float cycle
    phase: r2 * Math.PI * 2,
    opacity: 0.18 + r * 0.24,
  };
});

// Cap the canvas backing store: the glass refraction softens everything
// anyway, and full-res @3x canvases waste fill rate on iOS.
const MAX_DPR = 2;

interface Palette {
  base: [string, string, string];
  orbGold: string;
  orbViolet: string;
  orbAmber: string;
  glowInner: string;
  glowMid: string;
  counterGlow: string;
  horizon: string;
  mote: string;
  vignette: string;
  vignetteStart: number;
}

const LIGHT: Palette = {
  base: ["#FFFFFF", "#FBF6EE", "#F3EADB"],
  orbGold: "rgba(212,165,116,0.20)",
  orbViolet: "rgba(139,92,246,0.16)",
  orbAmber: "rgba(244,215,154,0.14)",
  glowInner: "rgba(212,165,116,0.55)",
  glowMid: "rgba(184,137,77,0.22)",
  counterGlow: "rgba(129,140,248,0.28)",
  horizon: "rgba(184,137,77,0.35)",
  mote: "184,137,77",
  vignette: "rgba(58,38,12,0.06)",
  vignetteStart: 0.55,
};

const DARK: Palette = {
  base: ["#12101A", "#0A0810", "#050409"],
  orbGold: "rgba(184,137,77,0.25)",
  orbViolet: "rgba(139,92,246,0.20)",
  orbAmber: "rgba(231,192,120,0.16)",
  glowInner: "rgba(212,165,116,0.40)",
  glowMid: "rgba(184,137,77,0.16)",
  counterGlow: "rgba(129,140,248,0.20)",
  horizon: "rgba(231,192,120,0.28)",
  mote: "231,192,120",
  vignette: "rgba(0,0,0,0.55)",
  vignetteStart: 0.5,
};

/** Soft radial orb: color core fading to transparent at the rim. */
function paintOrb(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, color);
  g.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
  ctx.fillStyle = g;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

/** One 96px noise tile, generated once per mount, tiled as film grain. */
function makeGrainTile(): HTMLCanvasElement {
  const tile = document.createElement("canvas");
  tile.width = 96;
  tile.height = 96;
  const tctx = tile.getContext("2d")!;
  const img = tctx.createImageData(96, 96);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(Math.random() * 255);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 10; // ~4% alpha
  }
  tctx.putImageData(img, 0, 0);
  return tile;
}

function paintFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  palette: Palette,
  grain: CanvasPattern | null,
): void {
  // Base wash: warm pearl (light) / deep ink (dark), lit from high center.
  const baseR = Math.max(w * 1.2, h * 0.9);
  const base = ctx.createRadialGradient(w / 2, -h * 0.1, 0, w / 2, -h * 0.1, baseR);
  base.addColorStop(0, palette.base[0]);
  base.addColorStop(0.45, palette.base[1]);
  base.addColorStop(1, palette.base[2]);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // Breathing gold + violet mesh (12s cycle, phase-offset like the CSS
  // gold-mesh-pulse animation this replaces).
  const breathe = (phase: number) =>
    1 + 0.08 * Math.sin((t / 12000) * Math.PI * 2 + phase);
  paintOrb(ctx, w * 0.08, h * 0.12, 260 * breathe(0), palette.orbGold);
  paintOrb(ctx, w * 0.94, h * 0.9, 280 * breathe(2.1), palette.orbViolet);
  paintOrb(ctx, w * 0.75, h * 0.33, 180 * breathe(4.2), palette.orbAmber);

  // THE hero glow: one large molten-gold orb high-center that breathes.
  const glowR =
    Math.min(w, h) * 0.74 * (1 + 0.05 * Math.sin((t / 9000) * Math.PI * 2));
  const gx = w / 2;
  const gy = -h * 0.18;
  const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, glowR);
  glow.addColorStop(0, palette.glowInner);
  glow.addColorStop(0.45, palette.glowMid);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // Cooler violet counter-glow low-right for depth.
  paintOrb(ctx, w * 0.92, h * 0.98, Math.min(w, h) * 0.64, palette.counterGlow);

  // Thin luminous horizon seam.
  const horizon = ctx.createLinearGradient(0, 0, w, 0);
  horizon.addColorStop(0, "rgba(0,0,0,0)");
  horizon.addColorStop(0.5, palette.horizon);
  horizon.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = horizon;
  ctx.fillRect(0, h * 0.42, w, 1);

  // Drifting motes: slow vertical float + gentle opacity pulse.
  for (const m of MOTES) {
    const cycle = Math.sin((t / (m.period * 1000)) * Math.PI * 2 + m.phase);
    const my = m.y * h + cycle * 10;
    const alpha =
      m.opacity *
      (0.6 + 0.4 * Math.sin((t / (m.period * 700)) * Math.PI * 2 + m.phase));
    ctx.fillStyle = `rgba(${palette.mote},${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(m.x * w, my, m.size / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Vignette to focus the center and seat the bottom chrome.
  const vigR = Math.max(w * 1.2, h * 0.8);
  const vig = ctx.createRadialGradient(
    w / 2, h * 0.38, vigR * palette.vignetteStart,
    w / 2, h * 0.38, vigR,
  );
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, palette.vignette);
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  // Fine static film grain so the wash never looks flat.
  if (grain) {
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, w, h);
  }
}

export function OnboardingHeroBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reducedMotion) {
      // Static frame: don't burn battery, and tell liquidglass this is not
      // per-frame dynamic content.
      canvas.removeAttribute("data-dynamic");
    }

    const grainTile = makeGrainTile();
    let grain: CanvasPattern | null = null;
    let raf = 0;
    let width = 0;
    let height = 0;

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      grain = ctx.createPattern(grainTile, "repeat");
    };

    const isDark = (): boolean =>
      document.documentElement.classList.contains("dark");

    const draw = (t: number): void => {
      paintFrame(ctx, width, height, t, isDark() ? DARK : LIGHT, grain);
    };

    resize();

    if (reducedMotion) {
      draw(0);
      // Theme flips must still repaint the static frame.
      const observer = new MutationObserver(() => draw(0));
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      const onResize = (): void => {
        resize();
        draw(0);
      };
      window.addEventListener("resize", onResize);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", onResize);
      };
    }

    const loop = (t: number): void => {
      draw(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onResize = (): void => resize();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-dynamic
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}

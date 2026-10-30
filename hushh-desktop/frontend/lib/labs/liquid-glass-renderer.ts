import type { CSSProperties } from "react";

export type LiquidGlassRendererMode = "reference" | "mirror";
export type LiquidGlassMirrorVisualState =
  | "idle"
  | "active"
  | "pressed"
  | "dragging"
  | "held"
  | "settling";

type MirrorGlassStyleOptions = {
  compact?: boolean;
  pressed?: boolean;
  state?: LiquidGlassMirrorVisualState;
};

function resolveMirrorState({ compact, pressed, state }: MirrorGlassStyleOptions) {
  const resolvedState = state ?? (pressed ? "pressed" : "idle");

  // ── body fill ──────────────────────────────────────────────
  // Keep this near-zero. The canvas refraction already carries the visual.
  // Any white fill here adds to the "milky" appearance.
  const bodyFill = compact
    ? {
        idle: 0.0,
        active: 0.005,
        pressed: 0.01,
        dragging: 0.01,
        held: 0.005,
        settling: 0.005,
      }
    : {
        idle: 0.0,
        active: 0.005,
        pressed: 0.01,
        dragging: 0.012,
        held: 0.008,
        settling: 0.005,
      };

  // ── edge border ────────────────────────────────────────────
  // Subtle edge definition (Chrome uses SVG bezel, we use a border)
  const edge = {
    idle: 0.10,
    active: 0.11,
    pressed: 0.14,
    dragging: 0.14,
    held: 0.12,
    settling: 0.11,
  } satisfies Record<LiquidGlassMirrorVisualState, number>;

  // ── outer shadow ───────────────────────────────────────────
  const shadow = {
    idle: 0.08,
    active: 0.09,
    pressed: 0.12,
    dragging: 0.13,
    held: 0.11,
    settling: 0.09,
  } satisfies Record<LiquidGlassMirrorVisualState, number>;

  // ── specular cap ───────────────────────────────────────────
  // Very subtle highlight – the specular map on the canvas handles most of this.
  const cap = compact
    ? {
        idle: 0.03,
        active: 0.04,
        pressed: 0.025,
        dragging: 0.02,
        held: 0.04,
        settling: 0.03,
      }
    : {
        idle: 0.04,
        active: 0.05,
        pressed: 0.03,
        dragging: 0.025,
        held: 0.06,
        settling: 0.04,
      };

  return {
    resolvedState,
    fillOpacity: bodyFill[resolvedState],
    edgeOpacity: edge[resolvedState],
    shadowOpacity: shadow[resolvedState],
    capOpacity: cap[resolvedState],
  };
}

export function resolveLiquidGlassStyle(
  filterId: string,
  mode: LiquidGlassRendererMode,
  base: CSSProperties = {},
  _options: MirrorGlassStyleOptions = {}
): CSSProperties {
  if (mode === "reference") {
    return {
      ...base,
      backdropFilter: `url(#${filterId})`,
      WebkitBackdropFilter: `url(#${filterId})`,
      willChange: "transform, backdrop-filter",
      isolation: "isolate",
    };
  }

  return resolveMirrorGlassContainerStyle(base);
}

export function resolveMirrorGlassContainerStyle(
  base: CSSProperties = {},
  options: MirrorGlassStyleOptions = {}
): CSSProperties {
  const { fillOpacity, edgeOpacity, shadowOpacity } = resolveMirrorState(options);
  const existingShadow = typeof base.boxShadow === "string" ? base.boxShadow : "";

  return {
    ...base,
    backgroundColor: fillOpacity > 0
      ? `rgba(255, 255, 255, ${fillOpacity})`
      : "transparent",
    border:
      typeof base.border === "string"
        ? base.border
        : `1px solid rgba(255, 255, 255, ${edgeOpacity})`,
    boxShadow: [
      existingShadow,
      `0 6px 20px rgba(0, 0, 0, ${shadowOpacity})`,
    ]
      .filter(Boolean)
      .join(", "),
    willChange: "transform",
    isolation: "isolate",
    transform:
      typeof base.transform === "string"
        ? `${base.transform} translateZ(0)`
        : "translateZ(0)",
    backfaceVisibility: "hidden",
    WebkitBackfaceVisibility: "hidden",
    contain: "paint",
    backgroundClip: "padding-box",
  };
}

export function resolveMirrorHighlightStyle(options: MirrorGlassStyleOptions = {}): CSSProperties {
  const { capOpacity } = resolveMirrorState(options);

  // Keep highlights extremely subtle — the canvas specular map already provides
  // the reflective sheen. Any white gradients here compound into milkiness.
  const topOpacity = capOpacity * 0.3;
  const rimOpacity = capOpacity * 0.15;

  return {
    position: "absolute",
    inset: 0,
    backgroundImage: [
      `radial-gradient(68% 34% at 50% 12%, rgba(255,255,255,${capOpacity}) 0%, rgba(255,255,255,${capOpacity * 0.2}) 26%, rgba(255,255,255,0) 58%)`,
      `linear-gradient(180deg, rgba(255,255,255,${topOpacity}) 0%, rgba(255,255,255,0) 40%)`,
      `radial-gradient(100% 80% at 22% 12%, rgba(255,255,255,${rimOpacity}) 0%, rgba(255,255,255,0) 50%)`,
    ].join(", "),
    mixBlendMode: "screen",
    pointerEvents: "none",
  };
}

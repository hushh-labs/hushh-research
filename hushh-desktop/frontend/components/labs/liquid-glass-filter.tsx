"use client";

import type { CSSProperties, ReactNode } from "react";

import { LiquidGlassCanvasLens, type LiquidGlassMirrorScenePainter } from "@/components/labs/liquid-glass-canvas-lens";
import { useLiquidFilterAssets, type LiquidFilterOptions } from "@/lib/labs/liquid-glass-core";
import {
  resolveLiquidGlassStyle,
  resolveMirrorGlassContainerStyle,
  resolveMirrorHighlightStyle,
  type LiquidGlassMirrorVisualState,
  type LiquidGlassRendererMode,
} from "@/lib/labs/liquid-glass-renderer";

export function LiquidGlassFilter({
  filterId,
  enabled,
  options,
  mode = "reference",
}: {
  filterId: string;
  enabled: boolean;
  options: LiquidFilterOptions;
  mode?: LiquidGlassRendererMode;
}) {
  const assets = useLiquidFilterAssets(enabled, options);
  const overscan = Math.ceil(
    Math.max(
      16,
      options.bezelWidth * 1.75,
      assets ? assets.scale * 0.45 : 0,
      (assets ? assets.blur : options.blur ?? 0) * 24
    )
  );

  if (!enabled || !assets || mode !== "reference") return null;

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0"
      focusable="false"
      colorInterpolationFilters="sRGB"
      shapeRendering="geometricPrecision"
    >
      <defs>
        <filter
          id={filterId}
          x={-overscan}
          y={-overscan}
          width={options.width + overscan * 2}
          height={options.height + overscan * 2}
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation={assets.blur} result="blurred_source" />
          <feImage
            href={assets.displacementMapUrl}
            x="0"
            y="0"
            width={options.width}
            height={options.height}
            result="displacement_map"
          />
          <feDisplacementMap
            in="blurred_source"
            in2="displacement_map"
            scale={assets.scale}
            xChannelSelector="R"
            yChannelSelector="G"
            result="displaced"
          />
          <feColorMatrix
            in="displaced"
            type="saturate"
            values={String(assets.specularSaturation)}
            result="displaced_saturated"
          />
          <feImage
            href={assets.specularMapUrl}
            x="0"
            y="0"
            width={options.width}
            height={options.height}
            result="specular_layer"
          />
          <feComposite
            in="displaced_saturated"
            in2="specular_layer"
            operator="in"
            result="specular_saturated"
          />
          <feComponentTransfer in="specular_layer" result="specular_faded">
            <feFuncA type="linear" slope={assets.specularOpacity} />
          </feComponentTransfer>
          <feBlend in="specular_saturated" in2="displaced" mode="normal" result="withSaturation" />
          <feBlend in="specular_faded" in2="withSaturation" mode="normal" />
        </filter>
      </defs>
    </svg>
  );
}

export function LiquidGlassBody({
  filterId,
  mode,
  style,
  compact = false,
  pressed = false,
  state,
  className,
  children,
  mirrorOptions,
  mirrorScene,
  opaqueBackground,
}: {
  filterId: string;
  mode: LiquidGlassRendererMode;
  style?: CSSProperties;
  compact?: boolean;
  pressed?: boolean;
  state?: LiquidGlassMirrorVisualState;
  className?: string;
  children?: ReactNode;
  mirrorOptions?: LiquidFilterOptions;
  mirrorScene?: LiquidGlassMirrorScenePainter;
  /** When set, renders a fully opaque background layer OVER the canvas refraction.
   *  Use for elements that must appear solid (e.g. Switch / Slider thumbs). */
  opaqueBackground?: string;
}) {
  if (mode === "reference") {
    return (
      <div
        className={className}
        style={glassBackdropStyle(filterId, style ?? {}, { mode, compact, pressed, state })}
      >
        {children}
      </div>
    );
  }

  const resolvedState = state ?? (pressed ? "pressed" : compact ? "active" : "idle");

  const resolvedStyle = resolveMirrorGlassContainerStyle(style ?? {}, { compact, pressed, state: resolvedState });

  return (
    <div
      className={className}
      style={resolvedStyle}
    >
      {mirrorOptions && mirrorScene ? (
        <LiquidGlassCanvasLens
          options={mirrorOptions}
          state={resolvedState}
          paintScene={mirrorScene}
          className="absolute inset-0"
        />
      ) : null}
      {opaqueBackground ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: opaqueBackground,
            borderRadius: "inherit",
            pointerEvents: "none",
          }}
        />
      ) : null}
      <div style={resolveMirrorHighlightStyle({ compact, pressed, state: resolvedState })} />
      {children}
    </div>
  );
}

export function glassBackdropStyle(
  filterId: string,
  base: CSSProperties = {},
  {
    mode = "reference",
    compact = false,
    pressed = false,
    state,
  }: {
    mode?: LiquidGlassRendererMode;
    compact?: boolean;
    pressed?: boolean;
    state?: LiquidGlassMirrorVisualState;
  } = {}
): CSSProperties {
  return resolveLiquidGlassStyle(filterId, mode, base, { compact, pressed, state });
}

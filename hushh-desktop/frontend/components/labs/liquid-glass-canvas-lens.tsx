"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  useLiquidFilterAssets,
  type LiquidFilterOptions,
} from "@/lib/labs/liquid-glass-core";
import type { LiquidGlassMirrorVisualState } from "@/lib/labs/liquid-glass-renderer";

export type LiquidGlassMirrorSceneEnv = {
  width: number;
  height: number;
  renderWidth: number;
  renderHeight: number;
  scale: number;
  state: LiquidGlassMirrorVisualState;
  padding: number;
};

export type LiquidGlassMirrorScenePainter = (
  ctx: CanvasRenderingContext2D,
  env: LiquidGlassMirrorSceneEnv
) => void;

type ImageAsset = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

function clampChannel(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function bilinearSample(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number
) {
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));

  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;

  const idx00 = (y0 * width + x0) * 4;
  const idx10 = (y0 * width + x1) * 4;
  const idx01 = (y1 * width + x0) * 4;
  const idx11 = (y1 * width + x1) * 4;

  const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;

  const r0 = mix(pixels[idx00] ?? 0, pixels[idx10] ?? 0, tx);
  const g0 = mix(pixels[idx00 + 1] ?? 0, pixels[idx10 + 1] ?? 0, tx);
  const b0 = mix(pixels[idx00 + 2] ?? 0, pixels[idx10 + 2] ?? 0, tx);
  const a0 = mix(pixels[idx00 + 3] ?? 0, pixels[idx10 + 3] ?? 0, tx);

  const r1 = mix(pixels[idx01] ?? 0, pixels[idx11] ?? 0, tx);
  const g1 = mix(pixels[idx01 + 1] ?? 0, pixels[idx11 + 1] ?? 0, tx);
  const b1 = mix(pixels[idx01 + 2] ?? 0, pixels[idx11 + 2] ?? 0, tx);
  const a1 = mix(pixels[idx01 + 3] ?? 0, pixels[idx11 + 3] ?? 0, tx);

  return [
    mix(r0, r1, ty),
    mix(g0, g1, ty),
    mix(b0, b1, ty),
    mix(a0, a1, ty),
  ] as const;
}

function useImageAsset(url: string | null) {
  const [asset, setAsset] = useState<ImageAsset | null>(null);

  useEffect(() => {
    if (!url || typeof document === "undefined") {
      setAsset(null);
      return;
    }

    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setAsset(null);
        return;
      }
      ctx.drawImage(image, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      setAsset({
        width: canvas.width,
        height: canvas.height,
        data: imageData.data,
      });
    };
    image.onerror = () => {
      if (!cancelled) setAsset(null);
    };
    image.src = url;

    return () => {
      cancelled = true;
    };
  }, [url]);

  return asset;
}

function stateOpticalMix(state: LiquidGlassMirrorVisualState) {
  switch (state) {
    case "pressed":
      return { shadow: 0.0, specular: 0.0, displacement: 1.04 };
    case "dragging":
      return { shadow: 0.0, specular: 0.0, displacement: 1.02 };
    case "held":
      return { shadow: 0.0, specular: 0.0, displacement: 0.92 };
    case "settling":
      return { shadow: 0.0, specular: 0.0, displacement: 0.96 };
    case "active":
      return { shadow: 0.0, specular: 0.0, displacement: 0.9 };
    case "idle":
    default:
      return { shadow: 0.0, specular: 0.0, displacement: 0.88 };
  }
}

export function LiquidGlassCanvasLens({
  options,
  state,
  paintScene,
  className,
  style,
}: {
  options: LiquidFilterOptions;
  state: LiquidGlassMirrorVisualState;
  paintScene: LiquidGlassMirrorScenePainter;
  className?: string;
  style?: React.CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const assets = useLiquidFilterAssets(true, options);
  const displacementAsset = useImageAsset(assets?.displacementMapUrl ?? null);
  const specularAsset = useImageAsset(assets?.specularMapUrl ?? null);
  const mix = useMemo(() => stateOpticalMix(state), [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !assets || !displacementAsset || !specularAsset) return;

    const renderWidth = displacementAsset.width;
    const renderHeight = displacementAsset.height;
    const scale = renderWidth / Math.max(1, options.width);

    const blurRadius = assets.blur > 0.01 ? Math.max(0.6, assets.blur * scale) : 0;
    const padding = Math.ceil(blurRadius * 2);

    const paddedWidth = renderWidth + padding * 2;
    const paddedHeight = renderHeight + padding * 2;

    canvas.width = renderWidth;
    canvas.height = renderHeight;

    const outputCtx = canvas.getContext("2d", { willReadFrequently: true });
    if (!outputCtx) return;

    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = paddedWidth;
    sourceCanvas.height = paddedHeight;
    const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!sourceCtx) return;

    sourceCtx.clearRect(0, 0, paddedWidth, paddedHeight);
    sourceCtx.save();
    sourceCtx.scale(scale, scale);
    sourceCtx.translate(padding / scale, padding / scale);
    paintScene(sourceCtx, {
      width: options.width,
      height: options.height,
      renderWidth,
      renderHeight,
      scale,
      state,
      padding: padding / scale,
    });
    sourceCtx.restore();

    let sourceImageData: ImageData;
    if (blurRadius > 0.01) {
      const blurCanvas = document.createElement("canvas");
      blurCanvas.width = paddedWidth;
      blurCanvas.height = paddedHeight;
      const blurCtx = blurCanvas.getContext("2d", { willReadFrequently: true });
      if (blurCtx) {
        blurCtx.filter = `blur(${blurRadius}px)`;
        blurCtx.drawImage(sourceCanvas, 0, 0);
        sourceImageData = blurCtx.getImageData(padding, padding, renderWidth, renderHeight);
      } else {
        sourceImageData = sourceCtx.getImageData(padding, padding, renderWidth, renderHeight);
      }
    } else {
      sourceImageData = sourceCtx.getImageData(padding, padding, renderWidth, renderHeight);
    }

    const displacementPixels = displacementAsset.data;
    const specularPixels = specularAsset.data;
    const sourcePixels = sourceImageData.data;
    const outputImageData = outputCtx.createImageData(renderWidth, renderHeight);
    const outputPixels = outputImageData.data;
    const scaledDisplacement = assets.scale * scale * mix.displacement;

    for (let y = 0; y < renderHeight; y += 1) {
      for (let x = 0; x < renderWidth; x += 1) {
        const idx = (y * renderWidth + x) * 4;
        const offsetX = (((displacementPixels[idx] ?? 128) - 128) / 127) * scaledDisplacement;
        const offsetY = (((displacementPixels[idx + 1] ?? 128) - 128) / 127) * scaledDisplacement;
        const [r, g, b, a] = bilinearSample(
          sourcePixels,
          renderWidth,
          renderHeight,
          x + offsetX,
          y + offsetY
        );

        const specularAlpha =
          ((specularPixels[idx + 3] ?? 0) / 255) * assets.specularOpacity * mix.specular;
        const shadowBias = mix.shadow * (1 - specularAlpha * 0.35);

        outputPixels[idx] = clampChannel(r * (1 - shadowBias) + (specularPixels[idx] ?? 0) * specularAlpha);
        outputPixels[idx + 1] = clampChannel(
          g * (1 - shadowBias) + (specularPixels[idx + 1] ?? 0) * specularAlpha
        );
        outputPixels[idx + 2] = clampChannel(
          b * (1 - shadowBias) + (specularPixels[idx + 2] ?? 0) * specularAlpha
        );
        outputPixels[idx + 3] = clampChannel(a);
      }
    }

    outputCtx.clearRect(0, 0, renderWidth, renderHeight);
    outputCtx.putImageData(outputImageData, 0, 0);
  }, [assets, displacementAsset, options.height, options.width, paintScene, specularAsset, state, mix]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
      style={{
        ...style,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}

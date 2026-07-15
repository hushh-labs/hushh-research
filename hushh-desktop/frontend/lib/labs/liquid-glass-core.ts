"use client";

import { useEffect, useRef, useState } from "react";

export type LiquidShapeType = "circle" | "squircle" | "rectangle" | "pill";
export type LiquidBezelType =
  | "convex_circle"
  | "convex_squircle"
  | "concave"
  | "lip";

type SurfaceFn = (x: number) => number;

export type LiquidFilterOptions = {
  width: number;
  height: number;
  radius: number;
  bezelWidth: number;
  glassThickness: number;
  refractiveIndex: number;
  bezelType?: LiquidBezelType;
  blur?: number;
  scaleRatio?: number;
  specularOpacity?: number;
  specularSaturation?: number;
  shape?: LiquidShapeType;
  cornerRadius?: number;
  squircleExponent?: number;
  quality?: number;
};

export type LiquidFilterAssets = {
  displacementMapUrl: string;
  specularMapUrl: string;
  scale: number;
  specularOpacity: number;
  specularSaturation: number;
  blur: number;
};

export type SpringOptions = {
  stiffness?: number;
  damping?: number;
  mass?: number;
  precision?: number;
};

const CONVEX_CIRCLE: SurfaceFn = (x) => Math.sqrt(1 - (1 - x) ** 2);
const CONVEX: SurfaceFn = (x) => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4);
const CONCAVE: SurfaceFn = (x) => 1 - CONVEX_CIRCLE(x);
const LIP: SurfaceFn = (x) => {
  const convex = CONVEX(x * 2);
  const concave = CONCAVE(x) + 0.1;
  const smootherstep = 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3;
  return convex * (1 - smootherstep) + concave * smootherstep;
};

function getSurfaceFunction(bezelType: LiquidBezelType = "convex_squircle"): SurfaceFn {
  switch (bezelType) {
    case "convex_circle":
      return CONVEX_CIRCLE;
    case "concave":
      return CONCAVE;
    case "lip":
      return LIP;
    case "convex_squircle":
    default:
      return CONVEX;
  }
}

function createImageData(width: number, height: number): ImageData {
  return new ImageData(width, height);
}

function imageDataToDataUrl(imageData: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

function resolveRenderScale(qualityMultiplier = 2): number {
  const devicePixelRatio =
    typeof window !== "undefined" ? window.devicePixelRatio ?? 1 : 1;
  return Math.min(8, Math.max(1, devicePixelRatio * qualityMultiplier));
}

function calculateDisplacementProfile(
  glassThickness = 200,
  bezelWidth = 50,
  bezelHeightFn: SurfaceFn = (x) => x,
  refractiveIndex = 1.5,
  samples = 128
): number[] {
  const eta = 1 / refractiveIndex;

  function refract(normalX: number, normalY: number): [number, number] | null {
    const dot = normalY;
    const k = 1 - eta * eta * (1 - dot * dot);
    if (k < 0) return null;
    const kSqrt = Math.sqrt(k);
    return [
      -(eta * dot + kSqrt) * normalX,
      eta - (eta * dot + kSqrt) * normalY,
    ];
  }

  return Array.from({ length: samples }, (_, i) => {
    const x = i / samples;
    const y = bezelHeightFn(x);
    const dx = x < 1 ? 0.0001 : -0.0001;
    const y2 = bezelHeightFn(x + dx);
    const derivative = (y2 - y) / dx;
    const magnitude = Math.sqrt(derivative * derivative + 1);
    const normalX = -derivative / magnitude;
    const normalY = -1 / magnitude;
    const refracted = refract(normalX, normalY);

    if (!refracted) return 0;

    const remainingHeightOnBezel = y * bezelWidth;
    const remainingHeight = remainingHeightOnBezel + glassThickness;
    return refracted[0] * (remainingHeight / refracted[1]);
  });
}

function calculateDisplacementMapWithShape(
  canvasWidth: number,
  canvasHeight: number,
  objectWidth: number,
  objectHeight: number,
  bezelWidth: number,
  maximumDisplacement: number,
  precomputedDisplacementMap: number[] = [],
  shape: LiquidShapeType = "pill",
  cornerRadius = 1,
  squircleExponent = 2,
  dpr?: number
) {
  const devicePixelRatio =
    dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio ?? 1 : 1);
  const bufferWidth = Math.floor(canvasWidth * devicePixelRatio);
  const bufferHeight = Math.floor(canvasHeight * devicePixelRatio);
  const imageData = createImageData(bufferWidth, bufferHeight);
  const neutral = 0xff008080;
  new Uint32Array(imageData.data.buffer).fill(neutral);

  const objectWidthPx = objectWidth * devicePixelRatio;
  const objectHeightPx = objectHeight * devicePixelRatio;
  const bezel = bezelWidth * devicePixelRatio;

  const objectX = (bufferWidth - objectWidthPx) / 2;
  const objectY = (bufferHeight - objectHeightPx) / 2;

  const maxCornerRadius = Math.min(objectWidthPx, objectHeightPx) / 2;
  let actualRadius: number;

  switch (shape) {
    case "circle":
      actualRadius = maxCornerRadius;
      break;
    case "pill":
      actualRadius = Math.min(objectWidthPx, objectHeightPx) / 2;
      break;
    case "rectangle":
      actualRadius = cornerRadius * maxCornerRadius;
      break;
    case "squircle":
    default:
      actualRadius = cornerRadius * maxCornerRadius;
      break;
  }

  const radius = actualRadius;

  const squircleDistance = (x: number, y: number, r: number, n: number): number => {
    if (r === 0) return Math.sqrt(x * x + y * y);
    const absX = Math.abs(x) / r;
    const absY = Math.abs(y) / r;
    return Math.pow(Math.pow(absX, n) + Math.pow(absY, n), 1 / n) * r;
  };

  for (let y1 = 0; y1 < objectHeightPx; y1 += 1) {
    for (let x1 = 0; x1 < objectWidthPx; x1 += 1) {
      const idx = ((objectY + y1) * bufferWidth + objectX + x1) * 4;

      const isOnLeftSide = x1 < radius;
      const isOnRightSide = x1 >= objectWidthPx - radius;
      const isOnTopSide = y1 < radius;
      const isOnBottomSide = y1 >= objectHeightPx - radius;

      let distanceToEdge = 0;
      let normalX = 0;
      let normalY = 0;
      let isInBezelRegion = false;

      if ((isOnLeftSide || isOnRightSide) && (isOnTopSide || isOnBottomSide)) {
        const x = isOnLeftSide ? x1 - radius : x1 - (objectWidthPx - radius);
        const y = isOnTopSide ? y1 - radius : y1 - (objectHeightPx - radius);

        const distanceFromCornerCenter =
          shape === "squircle" && cornerRadius > 0
            ? squircleDistance(x, y, radius, squircleExponent)
            : Math.sqrt(x * x + y * y);

        distanceToEdge = radius - distanceFromCornerCenter;

        if (distanceToEdge >= -1 && distanceToEdge <= bezel) {
          isInBezelRegion = true;
          const magnitude = Math.sqrt(x * x + y * y) || 1;
          normalX = x / magnitude;
          normalY = y / magnitude;
        }
      } else if (isOnLeftSide || isOnRightSide) {
        distanceToEdge = isOnLeftSide ? x1 : objectWidthPx - 1 - x1;
        if (distanceToEdge <= bezel) {
          isInBezelRegion = true;
          normalX = isOnLeftSide ? -1 : 1;
          normalY = 0;
        }
      } else if (isOnTopSide || isOnBottomSide) {
        distanceToEdge = isOnTopSide ? y1 : objectHeightPx - 1 - y1;
        if (distanceToEdge <= bezel) {
          isInBezelRegion = true;
          normalX = 0;
          normalY = isOnTopSide ? -1 : 1;
        }
      }

      if (isInBezelRegion && distanceToEdge >= 0) {
        const opacity = distanceToEdge >= 0 ? 1 : Math.max(0, 1 + distanceToEdge);
        const bezelIndex = Math.min(
          precomputedDisplacementMap.length - 1,
          Math.max(0, ((distanceToEdge / bezel) * precomputedDisplacementMap.length) | 0)
        );
        const distance = precomputedDisplacementMap[bezelIndex] ?? 0;
        const dX = (-normalX * distance) / maximumDisplacement;
        const dY = (-normalY * distance) / maximumDisplacement;

        imageData.data[idx] = 128 + dX * 127 * opacity;
        imageData.data[idx + 1] = 128 + dY * 127 * opacity;
        imageData.data[idx + 2] = 0;
        imageData.data[idx + 3] = 255;
      }
    }
  }

  return imageData;
}

function calculateRefractionSpecular(
  objectWidth: number,
  objectHeight: number,
  radius: number,
  bezelWidth: number,
  specularAngle = Math.PI / 3,
  dpr?: number
) {
  const devicePixelRatio =
    dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio ?? 1 : 1);
  const bufferWidth = Math.floor(objectWidth * devicePixelRatio);
  const bufferHeight = Math.floor(objectHeight * devicePixelRatio);
  const imageData = createImageData(bufferWidth, bufferHeight);

  const radiusPx = radius * devicePixelRatio;
  const bezelPx = bezelWidth * devicePixelRatio;
  const specularVector: [number, number] = [Math.cos(specularAngle), Math.sin(specularAngle)];
  const neutral = 0x00000000;
  new Uint32Array(imageData.data.buffer).fill(neutral);

  const radiusSquared = radiusPx ** 2;
  const radiusPlusOneSquared = (radiusPx + devicePixelRatio) ** 2;
  const radiusMinusBezelSquared = (radiusPx - bezelPx) ** 2;
  const widthBetweenRadiuses = bufferWidth - radiusPx * 2;
  const heightBetweenRadiuses = bufferHeight - radiusPx * 2;

  for (let y1 = 0; y1 < bufferHeight; y1 += 1) {
    for (let x1 = 0; x1 < bufferWidth; x1 += 1) {
      const idx = (y1 * bufferWidth + x1) * 4;

      const isOnLeftSide = x1 < radiusPx;
      const isOnRightSide = x1 >= bufferWidth - radiusPx;
      const isOnTopSide = y1 < radiusPx;
      const isOnBottomSide = y1 >= bufferHeight - radiusPx;

      const x = isOnLeftSide
        ? x1 - radiusPx
        : isOnRightSide
          ? x1 - radiusPx - widthBetweenRadiuses
          : 0;
      const y = isOnTopSide
        ? y1 - radiusPx
        : isOnBottomSide
          ? y1 - radiusPx - heightBetweenRadiuses
          : 0;

      const distanceToCenterSquared = x * x + y * y;
      const isInBezel =
        distanceToCenterSquared <= radiusPlusOneSquared &&
        distanceToCenterSquared >= radiusMinusBezelSquared;

      if (isInBezel) {
        const distanceFromCenter = Math.sqrt(distanceToCenterSquared);
        const distanceFromSide = radiusPx - distanceFromCenter;
        const opacity =
          distanceToCenterSquared < radiusSquared
            ? 1
            : 1 -
              (distanceFromCenter - Math.sqrt(radiusSquared)) /
                (Math.sqrt(radiusPlusOneSquared) - Math.sqrt(radiusSquared));
        const cos = x / distanceFromCenter;
        const sin = -y / distanceFromCenter;
        const dotProduct = Math.abs(cos * specularVector[0] + sin * specularVector[1]);
        const coefficient =
          dotProduct *
          Math.sqrt(1 - (1 - distanceFromSide / (1 * devicePixelRatio)) ** 2);
        const color = 255 * coefficient;
        const finalOpacity = color * coefficient * opacity;

        imageData.data[idx] = color;
        imageData.data[idx + 1] = color;
        imageData.data[idx + 2] = color;
        imageData.data[idx + 3] = finalOpacity;
      }
    }
  }

  return imageData;
}

function supportsCanvasRuntime() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

export function supportsLiquidGlassRuntime() {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const isEdge = /Edg\//.test(ua);
  const isChrome = /Chrome\//.test(ua) || /Chromium\//.test(ua);
  const isFirefox = /Firefox\//.test(ua);
  const isSafari = /Safari\//.test(ua) && !isChrome && !isEdge;
  const chromium = (isChrome || isEdge) && !isFirefox && !isSafari;
  const hasSvgFilters = typeof window.SVGFEColorMatrixElement !== "undefined";
  const hasBackdropFilter =
    typeof CSS !== "undefined" &&
    (CSS.supports("backdrop-filter: blur(1px)") ||
      CSS.supports("-webkit-backdrop-filter: blur(1px)"));
  return chromium && hasSvgFilters && hasBackdropFilter;
}

export function useSpringValue(
  target: number,
  {
    stiffness = 100,
    damping = 10,
    mass = 1,
    precision = 0.001,
  }: SpringOptions = {}
) {
  const [current, setCurrent] = useState(target);
  const velocityRef = useRef(0);
  const currentRef = useRef(target);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }

    const animate = () => {
      const displacement = target - currentRef.current;
      const springForce = displacement * stiffness;
      const dampingForce = velocityRef.current * damping;
      const acceleration = (springForce - dampingForce) / mass;

      velocityRef.current += acceleration * (1 / 60);
      currentRef.current += velocityRef.current * (1 / 60);

      if (
        Math.abs(displacement) < precision &&
        Math.abs(velocityRef.current) < precision
      ) {
        currentRef.current = target;
        velocityRef.current = 0;
        setCurrent(target);
        frameRef.current = null;
        return;
      }

      setCurrent(currentRef.current);
      frameRef.current = requestAnimationFrame(animate);
    };

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [target, stiffness, damping, mass, precision]);

  return current;
}

export function useLiquidFilterAssets(enabled: boolean, options: LiquidFilterOptions) {
  const [assets, setAssets] = useState<LiquidFilterAssets | null>(null);

  useEffect(() => {
    if (!enabled || !supportsCanvasRuntime()) {
      setAssets(null);
      return;
    }

    const bezelType = options.bezelType ?? "convex_squircle";
    const blur = options.blur ?? 0.2;
    const scaleRatio = options.scaleRatio ?? 1;
    const specularOpacity = options.specularOpacity ?? 0.4;
    const specularSaturation = options.specularSaturation ?? 4;
    const shape = options.shape ?? "pill";
    const cornerRadius = options.cornerRadius ?? 1;
    const squircleExponent = options.squircleExponent ?? 2;
    const quality = options.quality ?? 2;
    const renderScale = resolveRenderScale(quality);
    const profileSamples = Math.max(128, Math.round(128 * quality));

    try {
      const precomputedMap = calculateDisplacementProfile(
        options.glassThickness,
        options.bezelWidth,
        getSurfaceFunction(bezelType),
        options.refractiveIndex,
        profileSamples
      );

      const maxDisplacement =
        Math.max(...precomputedMap.map((value) => Math.abs(value))) || 1;

      const displacementImageData = calculateDisplacementMapWithShape(
        options.width,
        options.height,
        options.width,
        options.height,
        options.bezelWidth,
        100,
        precomputedMap,
        shape,
        cornerRadius,
        squircleExponent,
        renderScale
      );

      const specularImageData = calculateRefractionSpecular(
        options.width,
        options.height,
        options.radius,
        options.bezelWidth,
        undefined,
        renderScale
      );

      setAssets({
        displacementMapUrl: imageDataToDataUrl(displacementImageData),
        specularMapUrl: imageDataToDataUrl(specularImageData),
        scale: maxDisplacement * scaleRatio,
        specularOpacity,
        specularSaturation,
        blur,
      });
    } catch (error) {
      console.warn("[LiquidGlassLab] Failed to generate filter assets:", error);
      setAssets(null);
    }
  }, [
    enabled,
    options.bezelType,
    options.bezelWidth,
    options.blur,
    options.cornerRadius,
    options.glassThickness,
    options.height,
    options.quality,
    options.radius,
    options.refractiveIndex,
    options.scaleRatio,
    options.shape,
    options.specularOpacity,
    options.specularSaturation,
    options.squircleExponent,
    options.width,
  ]);

  return assets;
}

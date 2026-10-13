"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  LiquidGlassSceneProvider,
  LiquidGlassSceneRoot,
  useSceneMetrics,
} from "@/components/labs/liquid-glass-scene";
import { paintLabBackdrop, roundedRectPath } from "@/lib/labs/liquid-glass-scene-paint";
import { useLiquidGlassRendererMode } from "@/components/labs/liquid-glass-renderer-mode";
import { useSpringValue } from "@/lib/labs/liquid-glass-core";

import { LiquidGlassBody, LiquidGlassFilter } from "./liquid-glass-filter";

type SwitchSize = "xs" | "small" | "medium" | "large";

const SIZE_PRESETS: Record<
  SwitchSize,
  {
    sliderWidth: number;
    sliderHeight: number;
    thumbWidth: number;
    thumbHeight: number;
    thumbScale: number;
    bezelWidth: number;
    glassThickness: number;
  }
> = {
  xs: {
    sliderWidth: 70,
    sliderHeight: 30,
    thumbWidth: 64,
    thumbHeight: 40,
    thumbScale: 0.65,
    bezelWidth: 8,
    glassThickness: 10,
  },
  small: {
    sliderWidth: 100,
    sliderHeight: 42,
    thumbWidth: 92,
    thumbHeight: 58,
    thumbScale: 0.65,
    bezelWidth: 14,
    glassThickness: 15,
  },
  medium: {
    sliderWidth: 130,
    sliderHeight: 54,
    thumbWidth: 119,
    thumbHeight: 75,
    thumbScale: 0.65,
    bezelWidth: 16,
    glassThickness: 20,
  },
  large: {
    sliderWidth: 160,
    sliderHeight: 67,
    thumbWidth: 146,
    thumbHeight: 92,
    thumbScale: 0.65,
    bezelWidth: 18,
    glassThickness: 25,
  },
};

const CONTROL_RESET_CLASS =
  "appearance-none border-0 bg-transparent p-0 m-0 outline-none shadow-none";

export function LiquidGlassSwitchDemo() {
  const [xs, setXs] = useState(true);
  const [small, setSmall] = useState(false);
  const [medium, setMedium] = useState(true);
  const [large, setLarge] = useState(true);
  const sceneStyle = useMemo(
    () => ({
      backgroundImage:
        "linear-gradient(to right, currentColor 1px, transparent 1px),linear-gradient(to bottom, currentColor 1px, transparent 1px),radial-gradient(120% 100% at 10% 0%, var(--bg1), var(--bg2))",
      backgroundSize: "24px 24px, 24px 24px, 100% 100%",
      backgroundPosition: "12px 12px, 12px 12px, 0 0",
      backgroundRepeat: "repeat, repeat, no-repeat",
      backgroundAttachment: "scroll",
    }),
    []
  );

  return (
    <LiquidGlassSceneProvider sceneStyle={sceneStyle}>
      <section className="space-y-5">
      <div className="relative -ml-4 flex h-[36rem] w-[calc(100%+32px)] items-center justify-center overflow-hidden rounded-xl border border-black/10 text-black/5 dark:border-white/10 dark:text-white/5">
        <LiquidGlassSceneRoot className="absolute inset-0">
          <div className="absolute inset-x-14 top-12 grid grid-cols-4 gap-6">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="h-24 rounded-[2rem] border border-white/10 bg-black/16"
                style={{ opacity: 0.42 + index * 0.06 }}
              />
            ))}
          </div>
          <div className="absolute inset-x-10 bottom-12 grid grid-cols-2 gap-6 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                key={index}
                className="h-16 rounded-[1.6rem] border border-white/8 bg-white/8"
                style={{ opacity: 0.28 + (index % 4) * 0.08 }}
              />
            ))}
          </div>
        </LiquidGlassSceneRoot>

        <div className="relative z-10 grid grid-cols-2 gap-x-20 gap-y-10 md:grid-cols-4">
          <SwitchCluster label="XS" checked={xs} onCheckedChange={setXs} size="xs" />
          <SwitchCluster label="Small" checked={small} onCheckedChange={setSmall} size="small" />
          <SwitchCluster label="Medium" checked={medium} onCheckedChange={setMedium} size="medium" />
          <SwitchCluster label="Large" checked={large} onCheckedChange={setLarge} size="large" />
        </div>
      </div>
      </section>
    </LiquidGlassSceneProvider>
  );
}

function SwitchCluster({
  label,
  checked,
  onCheckedChange,
  size,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  size: SwitchSize;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <span className="text-xs font-semibold uppercase tracking-[0.28em] text-white/60">{label}</span>
      <LiquidGlassSwitch checked={checked} onCheckedChange={onCheckedChange} size={size} />
      <span className="text-[10px] font-medium uppercase tracking-[0.24em] text-white/44">
        {checked ? "On" : "Off"}
      </span>
    </div>
  );
}

function LiquidGlassSwitch({
  checked,
  onCheckedChange,
  size,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  size: SwitchSize;
  disabled?: boolean;
}) {
  const rendererMode = useLiquidGlassRendererMode();
  const dimensions = SIZE_PRESETS[size];
  const filterId = `liquid-switch-${useId().replace(/:/g, "-")}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const metrics = useSceneMetrics(containerRef);
  const [pointerDown, setPointerDown] = useState(false);
  const [motionActive, setMotionActive] = useState(false);
  const [xDragRatio, setXDragRatio] = useState(checked ? 1 : 0);
  const initialPointerXRef = useRef(0);
  const currentCheckedRef = useRef(checked);
  const motionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    currentCheckedRef.current = checked;
    if (!pointerDown) {
      setXDragRatio(checked ? 1 : 0);
    }
  }, [checked, pointerDown]);

  const sliderWidth = dimensions.sliderWidth;
  const sliderHeight = dimensions.sliderHeight;
  const thumbWidth = dimensions.thumbWidth;
  const thumbHeight = dimensions.thumbHeight;
  const thumbRadius = thumbHeight / 2;
  const thumbRestScale = dimensions.thumbScale;
  const thumbActiveScale = 0.9;
  const thumbRestOffset = ((1 - thumbRestScale) * thumbWidth) / 2;
  const travel =
    sliderWidth - sliderHeight - (thumbWidth - thumbHeight) * thumbRestScale;

  const activeThumbScale = pointerDown ? thumbActiveScale : thumbRestScale;
  const backgroundOpacity = pointerDown ? 0.1 : 1;
  const scaleRatio = pointerDown ? 0.9 : 0.4;
  const visualState = pointerDown ? (motionActive ? "dragging" : "held") : checked ? "active" : "idle";
  const thumbFilterOptions = useMemo(
    () => ({
      width: thumbWidth,
      height: thumbHeight,
      radius: thumbRadius,
      bezelWidth: dimensions.bezelWidth,
      glassThickness: dimensions.glassThickness,
      refractiveIndex: 1.5,
      bezelType: "lip" as const,
      shape: "pill" as const,
      blur: 0.2,
      scaleRatio,
      specularOpacity: 0.5,
      specularSaturation: 6,
    }),
    [
      dimensions.bezelWidth,
      dimensions.glassThickness,
      scaleRatio,
      thumbHeight,
      thumbRadius,
      thumbWidth,
    ]
  );

  const springRatio = useSpringValue(xDragRatio, {
    stiffness: 140,
    damping: 16,
    mass: 1,
    precision: 0.001,
  });

  const thumbX = springRatio * travel;
  const thumbMarginLeft = -thumbRestOffset + (sliderHeight - thumbHeight * thumbRestScale) / 2;
  const backgroundColor = useMemo(() => {
    const ratio = xDragRatio;
    const r = Math.round(148 + (59 - 148) * ratio);
    const g = Math.round(148 + (191 - 148) * ratio);
    const b = Math.round(159 + (78 - 159) * ratio);
    const a = Math.round(119 + (238 - 119) * ratio);
    return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
  }, [xDragRatio]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerDown || disabled) return;
      setMotionActive(true);
      if (motionTimeoutRef.current) clearTimeout(motionTimeoutRef.current);
      motionTimeoutRef.current = setTimeout(() => setMotionActive(false), 70);
      const baseRatio = currentCheckedRef.current ? 1 : 0;
      const displacementX = event.clientX - initialPointerXRef.current;
      const ratio = baseRatio + displacementX / travel;
      const overflow = ratio < 0 ? -ratio : ratio > 1 ? ratio - 1 : 0;
      const overflowSign = ratio < 0 ? -1 : 1;
      const dampedOverflow = (overflowSign * overflow) / 22;
      setXDragRatio(Math.min(1, Math.max(0, ratio)) + dampedOverflow);
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!pointerDown) return;
      setPointerDown(false);
      setMotionActive(false);
      if (motionTimeoutRef.current) clearTimeout(motionTimeoutRef.current);
      const distance = event.clientX - initialPointerXRef.current;
      if (Math.abs(distance) > 4) {
        const nextChecked = xDragRatio > 0.5;
        onCheckedChange(nextChecked);
        setXDragRatio(nextChecked ? 1 : 0);
      } else {
        const nextChecked = !currentCheckedRef.current;
        onCheckedChange(nextChecked);
        setXDragRatio(nextChecked ? 1 : 0);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [disabled, onCheckedChange, pointerDown, travel, xDragRatio]);

  useEffect(() => {
    return () => {
      if (motionTimeoutRef.current) clearTimeout(motionTimeoutRef.current);
    };
  }, []);

  const lensLeft = thumbMarginLeft + thumbX;
  const lensTop = (sliderHeight - thumbHeight) / 2;
  const paintMirrorScene = useCallback(
    (ctx: CanvasRenderingContext2D, env: { width: number; height: number; scale: number; padding?: number }) => {
      paintLabBackdrop(ctx, {
        width: env.width,
        height: env.height,
        offsetX: metrics.x + lensLeft,
        offsetY: metrics.y + lensTop,
        sceneWidth: metrics.width,
        sceneHeight: metrics.height,
        padding: env.padding,
        image: null,
      });
      ctx.save();
      ctx.translate(-lensLeft, -lensTop);
      paintSwitchSubstrate(ctx, {
        width: sliderWidth,
        height: sliderHeight,
        fillRatio: Math.max(0, Math.min(1, xDragRatio)),
        fillColor: backgroundColor,
      });
      ctx.restore();
    },
    [backgroundColor, lensLeft, lensTop, metrics.x, metrics.y, metrics.width, metrics.height, sliderHeight, sliderWidth, xDragRatio]
  );

  return (
    <div ref={containerRef} className={disabled ? "cursor-not-allowed opacity-50" : "select-none touch-none"}>
      <div
        className="relative"
        style={{
          width: sliderWidth,
          height: sliderHeight,
          borderRadius: sliderHeight / 2,
        }}
      >
        <div
          className="absolute inset-0 overflow-hidden"
          style={{
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 34%, rgba(18,21,28,0.15) 100%)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: sliderHeight / 2,
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.06), inset 0 -6px 14px rgba(0,0,0,0.08)",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              width: `${Math.max(18, xDragRatio * 100)}%`,
              backgroundColor,
              borderRadius: sliderHeight / 2,
              opacity: 0.9,
            }}
          />
        </div>

        <LiquidGlassFilter
          filterId={filterId}
          enabled
          mode={rendererMode}
          options={thumbFilterOptions}
        />

        <button
          type="button"
          aria-pressed={checked}
          disabled={disabled}
          onPointerDown={(event) => {
            if (disabled) return;
            setPointerDown(true);
            initialPointerXRef.current = event.clientX;
          }}
          className={
            disabled
              ? `absolute ${CONTROL_RESET_CLASS} cursor-not-allowed`
              : `absolute ${CONTROL_RESET_CLASS} transition-transform duration-100 ease-out`
          }
          style={{
            height: thumbHeight,
            width: thumbWidth,
            marginLeft: thumbMarginLeft,
            transform: `translateX(${thumbX}px) translateY(-50%) scale(${activeThumbScale})`,
            top: sliderHeight / 2,
            left: 0,
            borderRadius: thumbRadius,
          }}
        >
          <div className="relative h-full w-full">
            <LiquidGlassBody
              filterId={filterId}
              mode={rendererMode}
              pressed={pointerDown}
              state={visualState}
              mirrorOptions={thumbFilterOptions}
              mirrorScene={paintMirrorScene}
              opaqueBackground={`rgba(255,255,255,${backgroundOpacity})`}
              className="absolute inset-0 overflow-hidden"
              style={{
                borderRadius: thumbRadius,
                backgroundColor: `rgba(255,255,255,${backgroundOpacity})`,
                boxShadow: pointerDown
                  ? "0 4px 22px rgba(0,0,0,0.1), inset 2px 7px 24px rgba(0,0,0,0.09), inset -2px -7px 24px rgba(255,255,255,0.09)"
                  : "0 4px 22px rgba(0,0,0,0.1)",
                border: "1px solid rgba(255,255,255,0.08)",
              }}
            />
          </div>
        </button>
      </div>
    </div>
  );
}

function paintSwitchSubstrate(
  ctx: CanvasRenderingContext2D,
  {
    width,
    height,
    fillRatio,
    fillColor,
  }: {
    width: number;
    height: number;
    fillRatio: number;
    fillColor: string;
  }
) {
  const radius = height / 2;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(255,255,255,0.08)");
  gradient.addColorStop(0.34, "rgba(255,255,255,0.02)");
  gradient.addColorStop(1, "rgba(18,21,28,0.15)");
  roundedRectPath(ctx, 0, 0, width, height, radius);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.save();
  roundedRectPath(ctx, 0, 0, width, height, radius);
  ctx.clip();
  roundedRectPath(ctx, 0, 0, Math.max(18, width * fillRatio), height, radius);
  ctx.fillStyle = fillColor;
  ctx.fill();
  roundedRectPath(ctx, 1, 1, Math.max(16, width * fillRatio - 2), height * 0.48, radius - 1);
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.fill();
  ctx.restore();

  roundedRectPath(ctx, 1, 1, width - 2, height * 0.38, radius - 1);
  ctx.fillStyle = "rgba(255,255,255,0.065)";
  ctx.fill();
}

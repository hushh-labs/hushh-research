"use client";

import { Home, Search, Settings, User } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useCallback,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  LiquidGlassSceneProvider,
  LiquidGlassSceneRoot,
  useSceneMetrics,
} from "@/components/labs/liquid-glass-scene";
import { paintLabBackdrop, roundedRectPath, useLabSceneImage } from "@/lib/labs/liquid-glass-scene-paint";
import { useLiquidGlassRendererMode } from "@/components/labs/liquid-glass-renderer-mode";
import { useSpringValue } from "@/lib/labs/liquid-glass-core";
import { cn } from "@/lib/utils";

import { LiquidGlassBody, LiquidGlassFilter } from "./liquid-glass-filter";

type NavSize = "small" | "medium" | "large";

type NavItem = {
  id: string;
  label: string;
  icon: typeof Home;
};

const NAV_ITEMS: NavItem[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "search", label: "Search", icon: Search },
  { id: "profile", label: "Profile", icon: User },
  { id: "settings", label: "Settings", icon: Settings },
];

const CONTROL_RESET_CLASS =
  "appearance-none border-0 bg-transparent p-0 m-0 outline-none shadow-none";

const SIZE_PRESETS: Record<
  NavSize,
  {
    height: number;
    itemWidth: number;
    thumbHeight: number;
    bezelWidth: number;
    backgroundBezelWidth: number;
    glassThickness: number;
    fontSize: string;
    iconSize: number;
    thumbScale: number;
    thumbScaleY: number;
  }
> = {
  small: {
    height: 42,
    itemWidth: 60,
    thumbHeight: 38,
    bezelWidth: 6,
    backgroundBezelWidth: 15,
    glassThickness: 100,
    fontSize: "0.5rem",
    iconSize: 16,
    thumbScale: 1.4,
    thumbScaleY: 1.2,
  },
  medium: {
    height: 54,
    itemWidth: 80,
    thumbHeight: 50,
    bezelWidth: 8,
    backgroundBezelWidth: 30,
    glassThickness: 110,
    fontSize: "0.57rem",
    iconSize: 20,
    thumbScale: 1.3,
    thumbScaleY: 1.1,
  },
  large: {
    height: 67,
    itemWidth: 100,
    thumbHeight: 62,
    bezelWidth: 13,
    backgroundBezelWidth: 30,
    glassThickness: 120,
    fontSize: "0.675rem",
    iconSize: 24,
    thumbScale: 1.3,
    thumbScaleY: 1.1,
  },
};

export function LiquidGlassBottomNavDemo() {
  const [activeTab, setActiveTab] = useState("home");
  const [showBackgroundImage, setShowBackgroundImage] = useState(true);
  const [alwaysShowGlass, setAlwaysShowGlass] = useState(false);
  const backgroundImage = useLabSceneImage(showBackgroundImage);
  const sceneStyle = useMemo(
    () =>
      showBackgroundImage
        ? {
            backgroundImage:
              "url(https://images.unsplash.com/photo-1651784627380-58168977f4f9?q=80&w=987&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D)",
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            backgroundAttachment: "scroll",
          }
        : {
            backgroundImage:
              "linear-gradient(to right, currentColor 1px, transparent 1px),linear-gradient(to bottom, currentColor 1px, transparent 1px),radial-gradient(120% 100% at 10% 0%, var(--bg1), var(--bg2))",
            backgroundSize: "24px 24px, 24px 24px, 100% 100%",
            backgroundPosition: "12px 12px, 12px 12px, 0 0",
            backgroundRepeat: "repeat, repeat, no-repeat",
            backgroundAttachment: "scroll",
          },
    [showBackgroundImage]
  );

  return (
    <LiquidGlassSceneProvider sceneStyle={sceneStyle}>
      <section className="space-y-5">
      <div className="flex flex-wrap justify-end gap-3">
        <label className="inline-flex items-center gap-2 rounded-full bg-black/5 px-3 py-1.5 text-sm font-medium text-black/60 transition-colors hover:bg-black/10 dark:bg-white/10 dark:text-white/60 dark:hover:bg-white/20">
          <input
            type="checkbox"
            checked={alwaysShowGlass}
            onChange={(event) => setAlwaysShowGlass(event.target.checked)}
            className="accent-black dark:accent-white"
          />
          Always Show Glass
        </label>
        <label className="inline-flex items-center gap-2 rounded-full bg-black/5 px-3 py-1.5 text-sm font-medium text-black/60 transition-colors hover:bg-black/10 dark:bg-white/10 dark:text-white/60 dark:hover:bg-white/20">
          <input
            type="checkbox"
            checked={showBackgroundImage}
            onChange={(event) => setShowBackgroundImage(event.target.checked)}
            className="accent-black dark:accent-white"
          />
          Show Background Image
        </label>
      </div>

      <div
        className={cn(
          "relative -ml-4 h-[38rem] w-[calc(100%+32px)] overflow-hidden rounded-xl border border-black/10 text-black/5 transition-all duration-500 ease-in-out dark:border-white/10 dark:text-white/5"
        )}
      >
        <LiquidGlassSceneRoot
          className={cn("absolute inset-0", showBackgroundImage ? "animate-bg-pan" : "")}
        >
          {showBackgroundImage ? (
            <>
              <div className="absolute inset-0" />
              <a
                href="https://unsplash.com/@visaxslr"
                target="_blank"
                rel="noopener noreferrer"
                className="absolute left-3 top-3 inline-block text-[9px] uppercase tracking-wider text-white/40"
              >
                Photo by @visaxslr
                <br />
                on Unsplash
              </a>
            </>
          ) : null}

          <div className="absolute inset-x-10 top-10 grid grid-cols-3 gap-4">
            {["Watchlist", "Momentum", "Alerts"].map((label, index) => (
              <div
                key={label}
                className="rounded-[2rem] border border-white/10 bg-black/20 px-5 py-4 backdrop-blur-[1px]"
                style={{
                  transform: `translateY(${index * 6}px)`,
                }}
              >
                <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-white/46">
                  {label}
                </div>
                <div className="mt-3 h-3 rounded-full bg-white/18" />
                <div className="mt-2 h-3 w-4/5 rounded-full bg-white/10" />
                <div className="mt-2 h-16 rounded-[1.5rem] bg-white/8" />
              </div>
            ))}
          </div>

          <div className="absolute inset-x-12 bottom-24 grid grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                key={index}
                className="h-20 rounded-[1.75rem] border border-white/8 bg-black/20"
                style={{ opacity: 0.45 + (index % 4) * 0.08 }}
              />
            ))}
          </div>
        </LiquidGlassSceneRoot>

        <div className="relative z-10 mb-8 pt-14 text-center font-medium text-black/80 dark:text-white/80">
          Active:{" "}
          <span className="font-bold uppercase tracking-[0.24em]">{activeTab}</span>
        </div>

        <div className="relative z-10 flex h-[calc(100%-120px)] flex-col items-center justify-center gap-8">
          <LiquidGlassNav
            size="small"
            value={activeTab}
            onValueChange={setActiveTab}
            items={NAV_ITEMS}
            alwaysShowGlass={alwaysShowGlass}
            backgroundImage={backgroundImage}
            showBackgroundImage={showBackgroundImage}
          />
          <LiquidGlassNav
            size="medium"
            value={activeTab}
            onValueChange={setActiveTab}
            items={NAV_ITEMS}
            alwaysShowGlass={alwaysShowGlass}
            backgroundImage={backgroundImage}
            showBackgroundImage={showBackgroundImage}
          />
          <LiquidGlassNav
            size="large"
            value={activeTab}
            onValueChange={setActiveTab}
            items={NAV_ITEMS}
            alwaysShowGlass={alwaysShowGlass}
            backgroundImage={backgroundImage}
            showBackgroundImage={showBackgroundImage}
          />
        </div>
      </div>
      </section>
    </LiquidGlassSceneProvider>
  );
}

function LiquidGlassNav({
  value,
  onValueChange,
  items,
  size,
  alwaysShowGlass,
  backgroundImage,
  showBackgroundImage,
}: {
  value: string;
  onValueChange: (next: string) => void;
  items: NavItem[];
  size: NavSize;
  alwaysShowGlass?: boolean;
  backgroundImage: HTMLImageElement | null;
  showBackgroundImage: boolean;
}) {
  const rendererMode = useLiquidGlassRendererMode();
  const dimensions = SIZE_PRESETS[size];
  const sliderHeight = dimensions.height;
  const itemWidth = dimensions.itemWidth;
  const sliderWidth = itemWidth * items.length;
  const thumbWidth = itemWidth - 4;
  const thumbHeight = dimensions.thumbHeight;
  const thumbRadius = thumbHeight / 2;
  const centerOffset = (itemWidth - thumbWidth) / 2;
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.id === value)
  );
  const targetThumbX = selectedIndex * itemWidth + centerOffset;
  const filterId = useId().replace(/:/g, "-");
  const backgroundFilterId = `${filterId}-bg`;

  const [currentThumbX, setCurrentThumbX] = useState(targetThumbX);
  const [pointerDown, setPointerDown] = useState(false);
  const [glassVisible, setGlassVisible] = useState(false);
  const [wobbleScaleX, setWobbleScaleX] = useState(1);
  const [wobbleScaleY, setWobbleScaleY] = useState(1);
  const pointerStartXRef = useRef(0);
  const thumbStartXRef = useRef(targetThumbX);
  const hideGlassTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  
  const containerMetrics = useSceneMetrics(containerRef);
  const thumbMetrics = useSceneMetrics(thumbRef);

  useEffect(() => {
    if (pointerDown) return;
    setCurrentThumbX(targetThumbX);
  }, [pointerDown, targetThumbX]);

  const springTargetX = useSpringValue(currentThumbX, {
    stiffness: 130,
    damping: 18,
    mass: 1,
    precision: 0.05,
  });

  useEffect(() => {
    if (!pointerDown) {
      setWobbleScaleX(1);
      setWobbleScaleY(1);
    }
  }, [pointerDown, selectedIndex]);

  const isActive = alwaysShowGlass || pointerDown || glassVisible;
  const visualState =
    pointerDown ? "dragging" : alwaysShowGlass ? "held" : glassVisible ? "settling" : "idle";
  const thumbScale =
    (isActive ? dimensions.thumbScale : 1) * wobbleScaleX;
  const thumbScaleY =
    (isActive ? dimensions.thumbScaleY : 1) * wobbleScaleY;
  const thumbTop = (sliderHeight - thumbHeight) / 2;
  const thumbFilterOptions = useMemo(
    () => ({
      width: thumbWidth,
      height: thumbHeight,
      radius: thumbRadius,
      bezelWidth: dimensions.bezelWidth,
      glassThickness: dimensions.glassThickness,
      refractiveIndex: 1.5,
      bezelType: "convex_circle" as const,
      shape: "pill" as const,
      blur: 0,
      scaleRatio: 0.1,
      specularOpacity: 0.4,
      specularSaturation: 10,
    }),
    [dimensions.bezelWidth, dimensions.glassThickness, thumbHeight, thumbRadius, thumbWidth]
  );

  useEffect(() => {
    return () => {
      if (hideGlassTimeoutRef.current) {
        clearTimeout(hideGlassTimeoutRef.current);
      }
    };
  }, []);

  const showGlassBriefly = () => {
    if (hideGlassTimeoutRef.current) clearTimeout(hideGlassTimeoutRef.current);
    setGlassVisible(true);
    hideGlassTimeoutRef.current = setTimeout(() => {
      setGlassVisible(false);
    }, 280);
  };

  const finishGesture = useCallback(
    (clientX: number) => {
      setPointerDown(false);
      const thumbCenter = currentThumbX + thumbWidth / 2;
      let index = Math.floor(thumbCenter / itemWidth);
      index = Math.max(0, Math.min(index, items.length - 1));

      if (Math.abs(clientX - pointerStartXRef.current) < 5) {
        index = Math.round(targetThumbX / itemWidth);
      }

      const nextItem = items[index];
      if (nextItem && nextItem.id !== value) {
        onValueChange(nextItem.id);
      } else {
        setCurrentThumbX(targetThumbX);
      }
      showGlassBriefly();
    },
    [currentThumbX, itemWidth, items, onValueChange, targetThumbX, thumbWidth, value]
  );

  const handlePointerMove = useCallback(
    (clientX: number) => {
      const delta = clientX - pointerStartXRef.current;
      let nextPos = thumbStartXRef.current + delta;
      const maxPos = sliderWidth - thumbWidth - centerOffset;
      const minPos = centerOffset;

      if (nextPos < minPos) {
        const overflow = minPos - nextPos;
        nextPos = minPos - overflow / 3;
      }
      if (nextPos > maxPos) {
        const overflow = nextPos - maxPos;
        nextPos = maxPos + overflow / 3;
      }

      const speed = Math.abs(nextPos - currentThumbX);
      const stretchFactor = 1 + Math.min(speed * 0.05, 0.4);
      const squashFactor = 1 / stretchFactor;
      setWobbleScaleX((prev: number) => prev * 0.8 + stretchFactor * 0.2);
      setWobbleScaleY((prev: number) => prev * 0.8 + squashFactor * 0.2);
      setCurrentThumbX(nextPos);
    },
    [centerOffset, currentThumbX, sliderWidth, thumbWidth]
  );

  useEffect(() => {
    if (!pointerDown) return;

    const onPointerMove = (event: PointerEvent) => handlePointerMove(event.clientX);
    const onPointerUp = (event: PointerEvent) => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      finishGesture(event.clientX);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [finishGesture, handlePointerMove, pointerDown]);

  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    setPointerDown(true);
    pointerStartXRef.current = event.clientX;
    thumbStartXRef.current = currentThumbX;
    if (hideGlassTimeoutRef.current) clearTimeout(hideGlassTimeoutRef.current);
    setGlassVisible(true);
  };

  const paintMirrorScene = useCallback(
    (ctx: CanvasRenderingContext2D, env: { width: number; height: number; scale: number; padding?: number }) => {
      paintLabBackdrop(ctx, {
        width: env.width,
        height: env.height,
        offsetX: thumbMetrics.x,
        offsetY: thumbMetrics.y,
        sceneWidth: thumbMetrics.width,
        sceneHeight: thumbMetrics.height,
        padding: env.padding,
        image: backgroundImage,
      });

      // Subtle depth tint - significantly reduced to avoid "black blob" effect
      ctx.fillStyle = showBackgroundImage ? "rgba(8, 10, 16, 0.08)" : "rgba(8, 10, 16, 0.04)";
      ctx.fillRect(-100, -100, env.width + 200, env.height + 200);

      ctx.save();
      // Translate back by the local spring amount for substrate rendering
      ctx.translate(-springTargetX, -thumbTop);
      paintNavSubstrate(ctx, {
        width: sliderWidth,
        height: sliderHeight,
        radius: sliderHeight / 2,
        emphasis: showBackgroundImage ? 1.1 : 1,
      });
      ctx.restore();
    },
    [backgroundImage, thumbMetrics.x, thumbMetrics.y, thumbMetrics.width, thumbMetrics.height, showBackgroundImage, sliderHeight, sliderWidth, springTargetX, thumbTop]
  );

  const backgroundFilterOptions = useMemo(
    () => ({
      width: sliderWidth,
      height: sliderHeight,
      radius: sliderHeight / 2,
      bezelWidth: dimensions.backgroundBezelWidth,
      glassThickness: 190,
      refractiveIndex: 1.3,
      bezelType: "convex_squircle" as const,
      shape: "pill" as const,
      blur: 2,
      scaleRatio: 0.4,
      specularOpacity: 1,
      specularSaturation: 19,
    }),
    [dimensions.backgroundBezelWidth, sliderHeight, sliderWidth]
  );

  const paintBarMirrorScene = useCallback(
    (ctx: CanvasRenderingContext2D, env: { width: number; height: number; scale: number; padding?: number }) => {
      paintLabBackdrop(ctx, {
        width: env.width,
        height: env.height,
        offsetX: containerMetrics.x,
        offsetY: containerMetrics.y,
        sceneWidth: containerMetrics.width,
        sceneHeight: containerMetrics.height,
        padding: env.padding,
        image: backgroundImage,
      });
      // Very subtle bar tint
      ctx.fillStyle = showBackgroundImage ? "rgba(8, 10, 16, 0.12)" : "rgba(8, 10, 16, 0.06)";
      ctx.fillRect(-100, -100, env.width + 200, env.height + 200);
    },
    [backgroundImage, containerMetrics.x, containerMetrics.y, containerMetrics.width, containerMetrics.height, showBackgroundImage]
  );

  return (
    <div
      ref={containerRef}
      className="inline-block select-none touch-none"
      style={{
        transform: isActive ? "scale(1.05)" : "scale(1)",
        transition: "transform 0.1s ease-out",
      }}
    >
        <div
          className="relative"
          style={{
            width: sliderWidth,
            height: sliderHeight,
            borderRadius: sliderHeight / 2,
          }}
        >
          {rendererMode === "reference" ? (
            <>
              <LiquidGlassFilter
                filterId={backgroundFilterId}
                enabled
                mode={rendererMode}
                options={backgroundFilterOptions}
              />

              <LiquidGlassBody
                filterId={backgroundFilterId}
                mode={rendererMode}
                className="absolute inset-0"
                style={{
                  borderRadius: sliderHeight / 2,
                  boxShadow: "0 4px 20px rgba(0, 0, 0, 0.1)",
                  overflow: "hidden",
                }}
              />
            </>
          ) : (
            <>
              <LiquidGlassFilter
                filterId={backgroundFilterId}
                enabled
                mode={rendererMode}
                options={backgroundFilterOptions}
              />
              <LiquidGlassBody
                filterId={backgroundFilterId}
                mode={rendererMode}
                mirrorOptions={backgroundFilterOptions}
                mirrorScene={paintBarMirrorScene}
                className="absolute inset-0"
                style={{
                  borderRadius: sliderHeight / 2,
                  boxShadow: "0 4px 20px rgba(0, 0, 0, 0.1)",
                  overflow: "hidden",
                }}
              />
            </>
          )}

          <div className="absolute inset-0 z-30 flex">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(CONTROL_RESET_CLASS, "h-full cursor-pointer")}
                style={{ width: itemWidth }}
                onMouseDown={() => {
                  if (item.id !== value) {
                    onValueChange(item.id);
                    showGlassBriefly();
                  }
                }}
              />
            ))}
          </div>

          <div
            ref={thumbRef}
            className={cn(
              "absolute z-40 cursor-pointer",
              "transition-transform duration-100 ease-out"
            )}
            style={{
              height: thumbHeight,
              width: thumbWidth,
              transform: `translateX(${springTargetX}px) translateY(-50%) scale(${thumbScale}) scaleY(${thumbScaleY})`,
              top: sliderHeight / 2,
              left: 0,
              pointerEvents: "auto",
            }}
            onPointerDown={handleThumbPointerDown}
          >
            <LiquidGlassFilter
              filterId={filterId}
              enabled
              mode={rendererMode}
              options={thumbFilterOptions}
            />
            <LiquidGlassBody
              filterId={filterId}
              mode={rendererMode}
              compact
              pressed={isActive}
              state={visualState}
              mirrorOptions={thumbFilterOptions}
              mirrorScene={paintMirrorScene}
              className={cn(
                "absolute inset-0 overflow-hidden",
                rendererMode === "reference" && !isActive
                  ? "bg-[var(--glass-rgb)]/[var(--glass-bg-alpha)]"
                  : ""
              )}
              style={{
                borderRadius: thumbRadius,
                border: "1px solid rgba(255,255,255,0.12)",
                transition: "background-color 0.1s ease, box-shadow 0.1s ease",
              }}
            />
          </div>

          <div
            className={cn(
              "absolute inset-0 flex items-center justify-between pointer-events-none",
              isActive ? "z-20" : "z-50"
            )}
          >
            {items.map((item) => {
              const active = item.id === value;
              const ItemIcon = item.icon;
              return (
                <div
                  key={item.id}
                  className="flex flex-col items-center justify-center transition-all duration-100"
                  style={{
                    width: itemWidth,
                    height: "100%",
                    opacity: active ? 1 : 0.6,
                    transform: active ? "scale(1.05)" : "scale(1)",
                    gap: Math.max(2, Math.round(dimensions.iconSize * 0.18)),
                  }}
                >
                  <ItemIcon
                    size={dimensions.iconSize}
                    className="shrink-0 transition-colors"
                    style={{ color: active ? "red" : "white" }}
                  />
                  <span
                    className="truncate text-center font-medium leading-none text-black transition-colors dark:text-white"
                    style={{
                      fontSize: dimensions.fontSize,
                      color: active ? "red" : "white",
                      lineHeight: 1,
                    }}
                  >
                    {item.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
  );
}


function paintNavSubstrate(
  ctx: CanvasRenderingContext2D,
  {
    width,
    height,
    radius,
    emphasis = 1,
  }: { width: number; height: number; radius: number; emphasis?: number }
) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, `rgba(255,255,255,${0.11 * emphasis})`);
  gradient.addColorStop(0.35, `rgba(255,255,255,${0.05 * emphasis})`);
  gradient.addColorStop(1, `rgba(22,24,31,${0.22 * emphasis})`);
  roundedRectPath(ctx, 0, 0, width, height, radius);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = `rgba(255,255,255,${0.14 * emphasis})`;
  ctx.lineWidth = 1;
  ctx.stroke();

  roundedRectPath(ctx, width * 0.12, height * 0.18, width * 0.76, height * 0.22, height * 0.11);
  ctx.fillStyle = `rgba(255,255,255,${0.11 * emphasis})`;
  ctx.fill();

  roundedRectPath(ctx, width * 0.16, height * 0.64, width * 0.68, height * 0.18, height * 0.09);
  ctx.fillStyle = `rgba(0,0,0,${0.12 * emphasis})`;
  ctx.fill();

  roundedRectPath(ctx, 2, 2, width - 4, height * 0.46, radius - 2);
  ctx.fillStyle = `rgba(255,255,255,${0.05 * emphasis})`;
  ctx.fill();
}

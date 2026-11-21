"use client";

import * as React from "react";

import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import {
  createPointerVelocityTracker,
  runClosedFormSpring,
  type SpringDriverHandle,
} from "@/lib/motion/closed-form-spring";
import { cn } from "@/lib/utils";
import { appHaptic } from "@/lib/capacitor/app-haptics";

export type SegmentedPillIcon = React.ElementType<
  React.SVGProps<SVGSVGElement> & { size?: number | string }
>;

export type SegmentedPillOption = {
  value: string;
  label: string;
  icon?: SegmentedPillIcon;
  /** Optional selected-state counterpart for libraries with filled icons. */
  activeIcon?: SegmentedPillIcon;
  /** A count when sets are exactly countable, or a dot for attention unions
   * whose sources may overlap. */
  badge?: number | "dot";
  tone?: "default" | "accent";
  disabled?: boolean;
  dataTourId?: string;
};

type SegmentedPillSize = "compact" | "shell" | "default";
type SegmentedPillLayout = "inline" | "stacked";

type SegmentedPillProps = {
  value: string;
  options: SegmentedPillOption[];
  onValueChange: (value: string) => void;
  size?: SegmentedPillSize;
  layout?: SegmentedPillLayout;
  slotCount?: number;
  hitArea?: "segment" | "content";
  /**
   * Material ripple on press (default on). Tab bars pass false: the ripple
   * waits out a ~150 ms touch delay before it shows, then holds for 225 ms,
   * so on the bottom bar the grey bubble arrived after the icon had already
   * switched and lingered (measured on a Galaxy S24 Ultra, 2026-09-22).
   */
  ripple?: boolean;
  hapticFeedback?: boolean;
  /** Enables iOS Liquid-Glass C1 spring glide and horizontal scrub across segments. */
  liquidGlide?: boolean;
  className?: string;
  ariaLabel?: string;
};

const SIZE_STYLES: Record<
  SegmentedPillSize,
  {
    container: string;
    button: string;
    icon: "xs" | "sm" | "md";
    label: string;
    gap: string;
    stackedContainer: string;
    stackedButton: string;
    stackedLabel: string;
    stackedGap: string;
  }
> = {
  compact: {
    container: "min-h-[36px] p-0.5",
    button: "px-2 py-1 ui-text-tab-label",
    icon: "xs",
    label: "leading-none",
    gap: "gap-1",
    stackedContainer: "min-h-[52px] p-0.5",
    stackedButton: "px-1 py-1",
    stackedLabel: "text-[11px] leading-[13px]",
    stackedGap: "gap-0.5",
  },
  shell: {
    container: "min-h-[42px] p-1",
    button: "px-2.5 py-1.5 ui-text-tab-label",
    icon: "sm",
    label: "leading-none",
    gap: "gap-1.5",
    stackedContainer: "min-h-[64px] p-2",
    stackedButton: "min-h-11 px-1 py-1",
    stackedLabel: "text-[11px] leading-[13px]",
    stackedGap: "gap-[3px]",
  },
  default: {
    container: "min-h-[45px] p-1",
    button: "px-3 py-2 ui-text-form-label",
    icon: "sm",
    label: "",
    gap: "gap-1.5",
    stackedContainer: "min-h-[64px] p-2",
    stackedButton: "min-h-11 px-2 py-1",
    stackedLabel: "text-[11px] leading-[13px]",
    stackedGap: "gap-[3px]",
  },
};

export const SegmentedPill = React.forwardRef<
  HTMLDivElement,
  SegmentedPillProps
>(
  (
    {
      value,
      options,
      onValueChange,
      size = "default",
      layout = "inline",
      slotCount,
      hitArea = "segment",
      ripple = true,
      hapticFeedback = true,
      liquidGlide = false,
      className,
      ariaLabel = "Segmented selector",
    },
    ref,
  ) => {
    const styles = SIZE_STYLES[size];
    const isStacked = layout === "stacked";
    const [activePulseKey, setActivePulseKey] = React.useState(0);
    const previousValueRef = React.useRef(value);
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const indicatorRef = React.useRef<HTMLDivElement | null>(null);
    const springRef = React.useRef<SpringDriverHandle | null>(null);
    const slotPositionRef = React.useRef<number | null>(null);
    const slotVelocityRef = React.useRef(0);
    const suppressClickUntilRef = React.useRef(0);
    const scrubStateRef = React.useRef<{
      pointerId: number;
      startX: number;
      startY: number;
      startSlot: number;
      slotWidth: number;
      scrubbing: boolean;
      velocityTracker: ReturnType<typeof createPointerVelocityTracker>;
    } | null>(null);

    const setRefs = React.useCallback(
      (node: HTMLDivElement | null) => {
        containerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    const resolvedSlotCount = Math.max(
      slotCount ?? options.length,
      options.length,
      1,
    );
    const activeIndex = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );
    if (slotPositionRef.current === null) {
      slotPositionRef.current = activeIndex;
    }

    const writeIndicatorTransform = React.useCallback(
      (slotPos: number, slotVel: number) => {
        const indicator = indicatorRef.current;
        if (!indicator) return;
        const stretch = Math.min(0.11, Math.abs(slotVel) * 0.016);
        const scaleX = 1 + stretch;
        const scaleY = 1 - stretch * 0.42;
        indicator.style.transform =
          stretch > 0.002
            ? `translate3d(calc(${slotPos * 100}% + var(--segment-drag-x, 0px)), 0, 0) scale3d(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)}, 1)`
            : `translate3d(calc(${slotPos * 100}% + var(--segment-drag-x, 0px)), 0, 0)`;
      },
      [],
    );

    React.useLayoutEffect(() => {
      if (!liquidGlide) return;
      const currentPos = slotPositionRef.current ?? activeIndex;
      if (
        Math.abs(currentPos - activeIndex) < 0.001 &&
        Math.abs(slotVelocityRef.current) < 0.01
      ) {
        slotPositionRef.current = activeIndex;
        writeIndicatorTransform(activeIndex, 0);
        return;
      }
      springRef.current?.cancel();
      springRef.current = runClosedFormSpring({
        from: currentPos,
        to: activeIndex,
        options: {
          visualDuration: 0.28,
          bounce: 0.08,
          initialVelocity: slotVelocityRef.current,
          restDelta: 0.002,
          restSpeed: 0.04,
        },
        onUpdate: (pos, vel) => {
          slotPositionRef.current = pos;
          slotVelocityRef.current = vel;
          writeIndicatorTransform(pos, vel);
        },
        onComplete: () => {
          slotPositionRef.current = activeIndex;
          slotVelocityRef.current = 0;
          writeIndicatorTransform(activeIndex, 0);
        },
      });
      return () => {
        springRef.current?.cancel();
      };
    }, [activeIndex, liquidGlide, writeIndicatorTransform]);

    React.useEffect(() => {
      if (previousValueRef.current === value) {
        return;
      }
      previousValueRef.current = value;
      setActivePulseKey((current) => current + 1);
    }, [value]);

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
      if (!liquidGlide || options.length < 2) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const slotWidth = (rect.width - 8) / resolvedSlotCount;
      if (slotWidth <= 8) return;
      const velocityTracker = createPointerVelocityTracker();
      velocityTracker.reset(event.clientX, event.timeStamp);
      scrubStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startSlot: slotPositionRef.current ?? activeIndex,
        slotWidth,
        scrubbing: false,
        velocityTracker,
      };
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
      const scrub = scrubStateRef.current;
      if (!scrub || scrub.pointerId !== event.pointerId) return;
      const dx = event.clientX - scrub.startX;
      const dy = event.clientY - scrub.startY;
      if (!scrub.scrubbing) {
        if (Math.abs(dx) < 10) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          scrubStateRef.current = null;
          return;
        }
        scrub.scrubbing = true;
        springRef.current?.cancel();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Ignore if pointer capture is unavailable on synthetic events.
        }
      }
      scrub.velocityTracker.push(event.clientX, event.timeStamp);
      const rawSlot = scrub.startSlot + dx / scrub.slotWidth;
      const maxSlot = Math.max(0, options.length - 1);
      const clampedSlot =
        rawSlot < 0
          ? rawSlot * 0.18
          : rawSlot > maxSlot
            ? maxSlot + (rawSlot - maxSlot) * 0.18
            : rawSlot;
      const slotVel = scrub.velocityTracker.velocityPxPerSec(event.timeStamp) / scrub.slotWidth;
      slotPositionRef.current = clampedSlot;
      slotVelocityRef.current = slotVel;
      writeIndicatorTransform(clampedSlot, slotVel * 0.65);
      suppressClickUntilRef.current = performance.now() + 360;
    };

    const finishScrub = (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const scrub = scrubStateRef.current;
      if (!scrub || scrub.pointerId !== event.pointerId) return;
      scrubStateRef.current = null;
      if (!scrub.scrubbing) return;
      const currentPos = slotPositionRef.current ?? activeIndex;
      const slotVel = cancelled
        ? 0
        : scrub.velocityTracker.velocityPxPerSec(event.timeStamp) / scrub.slotWidth;
      slotVelocityRef.current = slotVel;
      const projected = currentPos + Math.max(-0.65, Math.min(0.65, slotVel * 0.08));
      const nearestIndex = cancelled
        ? activeIndex
        : Math.max(0, Math.min(options.length - 1, Math.round(projected)));
      const targetOption = options[nearestIndex];
      if (!cancelled && targetOption && !targetOption.disabled && targetOption.value !== value) {
        onValueChange(targetOption.value);
        if (hapticFeedback) appHaptic("selection");
        return;
      }
      springRef.current?.cancel();
      springRef.current = runClosedFormSpring({
        from: currentPos,
        to: activeIndex,
        options: {
          visualDuration: 0.26,
          bounce: 0.08,
          initialVelocity: slotVel,
          restDelta: 0.002,
          restSpeed: 0.04,
        },
        onUpdate: (pos, vel) => {
          slotPositionRef.current = pos;
          slotVelocityRef.current = vel;
          writeIndicatorTransform(pos, vel);
        },
        onComplete: () => {
          slotPositionRef.current = activeIndex;
          slotVelocityRef.current = 0;
          writeIndicatorTransform(activeIndex, 0);
        },
      });
    };

    return (
      <div
        ref={setRefs}
        data-theme-control
        data-liquid-glide={liquidGlide ? "true" : undefined}
        role="radiogroup"
        aria-label={ariaLabel}
        onPointerDown={liquidGlide ? handlePointerDown : undefined}
        onPointerMove={liquidGlide ? handlePointerMove : undefined}
        onPointerUp={liquidGlide ? (e) => finishScrub(e, false) : undefined}
        onPointerCancel={liquidGlide ? (e) => finishScrub(e, true) : undefined}
        onClickCapture={
          liquidGlide
            ? (e) => {
                if (performance.now() < suppressClickUntilRef.current) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }
            : undefined
        }
        className={cn(
          "pointer-events-none relative grid items-center rounded-full border border-[color:var(--app-glass-border)] bg-[color:var(--app-glass-surface)] shadow-[var(--app-glass-shadow)] backdrop-blur-[var(--blur-standard)]",
          liquidGlide && "touch-pan-y select-none",
          isStacked ? styles.stackedContainer : styles.container,
          className,
        )}
        style={{
          gridTemplateColumns: `repeat(${resolvedSlotCount}, minmax(0, 1fr))`,
        }}
      >
        <div
          ref={indicatorRef}
          aria-hidden
          data-segment-indicator
          className={cn(
            "pointer-events-none absolute left-1 top-1 bottom-1 origin-center overflow-hidden rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] will-change-transform dark:bg-white/[0.14] dark:shadow-[0_1px_2px_rgba(0,0,0,0.28)]",
            !liquidGlide &&
              "transition-transform duration-[150ms] ease-[var(--ease-out)] motion-reduce:transition-none",
          )}
          style={{
            width: `calc((100% - 0.5rem) / ${resolvedSlotCount})`,
            transform: `translate3d(calc(${activeIndex * 100}% + var(--segment-drag-x, 0px)), 0, 0)`,
          }}
        >
          <span
            key={`${value}-${activePulseKey}`}
            data-segment-active-pulse
            className="absolute inset-0 rounded-full bg-transparent opacity-0"
          />
        </div>
        {options.map((option) => {
          const isActive = option.value === value;
          const isDisabled = !!option.disabled;
          const isAccent = option.tone === "accent";
          const needsWrapper = hitArea === "content" || hitArea === "segment";
          const OptionIcon =
            isActive && option.activeIcon ? option.activeIcon : option.icon;
          const numericBadge =
            typeof option.badge === "number" ? option.badge : null;
          const hasNumericBadge = numericBadge !== null && numericBadge > 0;
          const numericBadgeText =
            numericBadge !== null && numericBadge > 9 ? "9+" : numericBadge;
          const hasDotBadge = option.badge === "dot";
          const button = (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-disabled={isDisabled}
              data-tour-id={option.dataTourId}
              disabled={isDisabled}
              onClick={() => {
                if (isDisabled) return;
                onValueChange(option.value);
                if (hapticFeedback && !isActive) appHaptic("selection");
              }}
              className={cn(
                "relative z-10 flex min-w-0 items-center justify-center overflow-hidden rounded-full text-center transition-[color,opacity] duration-100 ease-[cubic-bezier(0.2,0,0,1)] disabled:cursor-not-allowed",
                "pointer-events-auto",
                hitArea === "content"
                  ? "w-fit flex-none self-center"
                  : "h-full w-full",
                isStacked ? "flex-col" : "flex-row",
                isStacked ? styles.stackedButton : styles.button,
                isStacked ? styles.stackedGap : styles.gap,
                isActive
                  ? "text-[color:var(--app-accent)] font-medium segmented-pill-active-choice"
                : isAccent
                    ? "text-[color:var(--app-accent)] segmented-pill-button-accent"
                    : "text-muted-foreground segmented-pill-button-default",
                isDisabled && "opacity-45",
              )}
            >
              {OptionIcon || hasNumericBadge || hasDotBadge ? (
                <span className="relative flex shrink-0 items-center justify-center">
                  {OptionIcon ? (
                    <OptionIcon
                      data-segment-icon
                      data-segment-icon-variant={
                        isActive && option.activeIcon ? "active" : "default"
                      }
                      size={isStacked ? 22 : { xs: 14, sm: 16, md: 20 }[styles.icon]}
                      className="shrink-0"
                      aria-hidden
                    />
                  ) : null}
                  {hasNumericBadge ? (
                    <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-background bg-red-500 px-1 text-[11px] font-bold leading-none text-white">
                      {numericBadgeText}
                    </span>
                  ) : null}
                  {hasDotBadge ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-background bg-red-500"
                      />
                      <span className="sr-only">New activity</span>
                    </>
                  ) : null}
                </span>
              ) : null}
              <span
                className={cn(
                  isStacked
                    ? "max-w-full whitespace-normal"
                    : "whitespace-nowrap",
                  isStacked ? styles.stackedLabel : styles.label,
                )}
              >
                {option.label}
              </span>
              {ripple ? (
                <MaterialRipple
                  variant={isAccent ? "link" : "none"}
                  effect={isAccent ? "glass" : "fade"}
                  disableHover
                  disabled={isDisabled}
                  className="z-0"
                />
              ) : null}
            </button>
          );

          if (needsWrapper) {
            return (
              <div
                key={option.value}
                className={cn(
                  "pointer-events-none relative z-10 flex min-w-0 items-center justify-center",
                  hitArea === "segment" ? "h-full px-[2px] py-[2px]" : "",
                  hitArea === "content" && isStacked ? "py-0.5" : "",
                )}
              >
                {button}
              </div>
            );
          }

          return button;
        })}
      </div>
    );
  },
);

SegmentedPill.displayName = "SegmentedPill";

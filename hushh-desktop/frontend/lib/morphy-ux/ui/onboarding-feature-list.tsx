"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { useFeatureRailTrail } from "@/lib/morphy-ux/hooks/use-feature-rail-trail";
import { FeatureRail } from "@/lib/morphy-ux/ui/feature-rail";
import { IconChip, type IconChipTone } from "@/lib/morphy-ux/ui/icon-chip";

export interface OnboardingFeatureItem {
  tone: IconChipTone;
  icon: LucideIcon;
  title: string;
  subtitle: string;
}

export function OnboardingFeatureList({
  features,
  animate = true,
}: {
  features: OnboardingFeatureItem[];
  animate?: boolean;
}) {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const activeLineEl = React.useRef<HTMLDivElement | null>(null);
  const topDotEl = React.useRef<HTMLDivElement | null>(null);
  const bottomDotEl = React.useRef<HTMLDivElement | null>(null);
  const chipRefs = React.useRef<Array<HTMLDivElement | null>>([]);
  const [railOffsets, setRailOffsets] = React.useState({
    top: 24,
    bottom: 24,
  });

  const recalculateRailOffsets = React.useCallback(() => {
    const container = listRef.current;
    const firstChip = chipRefs.current[0];
    const lastChip = chipRefs.current[features.length - 1];
    if (!container || !firstChip || !lastChip) return;

    const containerRect = container.getBoundingClientRect();
    const firstRect = firstChip.getBoundingClientRect();
    const lastRect = lastChip.getBoundingClientRect();
    // Anchor rail from bottom-center of first chip to top-center of last chip.
    const nextTop = Math.max(firstRect.bottom - containerRect.top, 0);
    const lastTop = lastRect.top - containerRect.top;
    const nextBottom = Math.max(containerRect.height - lastTop, 0);

    setRailOffsets((current) => {
      if (
        Math.abs(current.top - nextTop) < 0.5 &&
        Math.abs(current.bottom - nextBottom) < 0.5
      ) {
        return current;
      }
      return { top: nextTop, bottom: nextBottom };
    });
  }, [features.length]);

  React.useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const container = listRef.current;
    if (!container) return;

    let raf = window.requestAnimationFrame(() => {
      recalculateRailOffsets();
    });

    const resizeObserver = new ResizeObserver(() => {
      recalculateRailOffsets();
    });

    resizeObserver.observe(container);
    chipRefs.current.forEach((chip) => {
      if (chip) resizeObserver.observe(chip);
    });

    const onResize = () => recalculateRailOffsets();
    window.addEventListener("resize", onResize);

    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [recalculateRailOffsets, features.length]);

  useFeatureRailTrail({
    enabled: animate,
    railRefs: {
      activeLineEl,
      topDotEl,
      bottomDotEl,
    },
    chipRefs,
  });

  return (
    <div ref={listRef} data-feature-rail-list="true" className="relative">
      <FeatureRail
        className="left-2 sm:left-3"
        style={{
          top: `${railOffsets.top}px`,
          bottom: `${railOffsets.bottom}px`,
        }}
        topDotRef={topDotEl}
        activeLineRef={activeLineEl}
        bottomDotRef={bottomDotEl}
      />

      <div className="relative z-10 space-y-8 px-2 sm:space-y-10 sm:px-3">
        {features.map((feature, index) => (
          <div
            key={feature.title}
            className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-4"
          >
            <IconChip
              ref={(node) => {
                chipRefs.current[index] = node;
              }}
              icon={feature.icon}
              tone={feature.tone}
              state={animate ? "muted" : "active"}
              className="relative z-20"
            />

            <div className="min-w-0">
              <p className="text-lg font-bold leading-tight text-foreground">
                {feature.title}
              </p>
              <p className="mt-1 text-base leading-normal text-muted-foreground">
                {feature.subtitle}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

interface FeatureRailProps {
  className?: string;
  style?: React.CSSProperties;
  topDotRef?: React.Ref<HTMLDivElement>;
  activeLineRef?: React.Ref<HTMLDivElement>;
  bottomDotRef?: React.Ref<HTMLDivElement>;
}

export function FeatureRail({
  className,
  style,
  topDotRef,
  activeLineRef,
  bottomDotRef,
}: FeatureRailProps) {
  return (
    <div
      aria-hidden
      style={style}
      className={cn(
        "pointer-events-none absolute left-0 z-0 w-12",
        className
      )}
    >
      <div className="absolute inset-0">
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 overflow-hidden">
          <div className="absolute inset-0 bg-border/80" />
          <div
            ref={activeLineRef}
            data-rail-line="active"
            className="absolute inset-0 origin-top scale-y-0 bg-gradient-to-b from-[var(--tone-blue)] via-[var(--tone-green)] to-[var(--tone-orange)]"
          />
        </div>

        <div
          ref={topDotRef}
          data-rail-dot="top"
          data-state="muted"
          className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border/90 opacity-40 transition-opacity duration-200 data-[state=active]:opacity-100"
        />
        <div
          ref={bottomDotRef}
          data-rail-dot="bottom"
          data-state="muted"
          className="absolute left-1/2 bottom-0 h-1.5 w-1.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-border/90 opacity-40 transition-opacity duration-200 data-[state=active]:opacity-100"
        />
      </div>
    </div>
  );
}

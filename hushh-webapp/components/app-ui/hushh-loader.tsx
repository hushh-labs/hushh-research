"use client";

import React from "react";
import { cn } from "@/lib/utils";

export type HushhLoaderVariant = "fullscreen" | "page" | "inline" | "compact";

export interface HushhLoaderProps {
  label?: string;
  variant?: HushhLoaderVariant;
  className?: string;
}

/**
 * HushhLoader
 * Single canonical loader for the entire app (branding symmetry).
 *
 * IMPORTANT:
 * - No debug strings (per product decision).
 * - UI-only. No backend/plugin involvement.
 * - No spinner/progress glyphs here; top StepProgressBar owns progress indication.
 * - This component renders only neutral static placeholder text.
 */
export function HushhLoader({
  label = "Loading…",
  variant = "page",
  className,
}: HushhLoaderProps) {
  if (variant === "compact") {
    return <span className={cn("inline-block text-muted-foreground", className)}>…</span>;
  }

  const isFullscreen = variant === "fullscreen";
  const isPage = variant === "page";
  const isInline = variant === "inline";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "flex items-center justify-center",
        isFullscreen
          ? "h-screen w-full"
          : isPage
          ? "min-h-[60vh] w-full"
          : isInline
          ? "w-full py-6"
          : "",
        className
      )}
    >
      <p className={cn("text-sm text-muted-foreground", isInline && "text-xs")}>{label}</p>
    </div>
  );
}

"use client";

import React from "react";
import { cva } from "class-variance-authority";
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
const loaderVariants = cva("flex items-center justify-center text-muted-foreground", {
  variants: {
    variant: {
      fullscreen: "h-screen w-full",
      page: "min-h-[60vh] w-full",
      inline: "w-full py-6",
      compact: "inline-block",
    },
  },
  defaultVariants: {
    variant: "page",
  },
});

export function HushhLoader({
  label = "Loading…",
  variant = "page",
  className,
}: HushhLoaderProps) {
  if (variant === "compact") {
    return (
      <span className={cn(loaderVariants({ variant }), className)} aria-hidden="true">
        …
      </span>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-atomic="true"
      className={cn(loaderVariants({ variant }), className)}
    >
      <p className={cn("text-sm motion-safe:animate-pulse", variant === "inline" && "text-xs")}>{label}</p>
    </div>
  );
}

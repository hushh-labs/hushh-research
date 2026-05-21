"use client";

import { useEffect, useState } from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

export type HushhLoaderVariant = "fullscreen" | "page" | "inline" | "compact";

export interface HushhLoaderProps {
  label?: string;
  variant?: HushhLoaderVariant;
  className?: string;
  delayMs?: number; // New Feature: Prevents quick UI flashes on high-speed transitions
}

/**
 * HushhLoader
 * Single canonical placeholder loader for the entire app (branding symmetry).
 *
 * DESIGN CONSTRAINTS:
 * - No debug strings (per product decision).
 * - UI-only layer. No backend or execution dependency hooks.
 * - This component renders only neutral, micro-animated ambient text.
 */
const loaderVariants = cva(
  "flex items-center justify-center text-muted-foreground select-none pointer-events-none animate-pulse", // Ambient pulse provides life without heavy elements
  {
    variants: {
      variant: {
        fullscreen: "fixed inset-0 z-50 h-screen w-screen bg-background/80 backdrop-blur-sm",
        page: "min-h-[60vh] w-full",
        inline: "w-full py-6",
        compact: "inline-flex items-center justify-center",
      },
    },
    defaultVariants: {
      variant: "page",
    },
  }
);

export function HushhLoader({
  label = "Loading…",
  variant = "page",
  className,
  delayMs = 0, // Set to 200-300ms on slower endpoints to keep loading experiences smooth
}: HushhLoaderProps) {
  const [isMounted, setIsMounted] = useState(delayMs === 0);

  // Handle delayed mount thresholds to optimize rapid UI transition flows
  useEffect(() => {
    if (delayMs <= 0) return;

    const showTimer = setTimeout(() => {
      setIsMounted(true);
    }, delayMs);

    return () => clearTimeout(showTimer);
  }, [delayMs]);

  if (!isMounted) return null;

  // Accessible Compact Variant Block
  if (variant === "compact") {
    return (
      <span 
        className={cn(loaderVariants({ variant }), "font-medium tracking-widest", className)} 
        role="status" 
        aria-live="polite"
      >
        <span className="sr-only">{label}</span>
        <span aria-hidden="true" className="opacity-70 animate-bounce">…</span>
      </span>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(loaderVariants({ variant }), className)}
    >
      <p 
        className={cn(
          "font-medium tracking-tight text-foreground/70", 
          variant === "fullscreen" && "text-base font-semibold tracking-wide",
          variant === "inline" && "text-xs text-muted-foreground",
          variant === "page" && "text-sm text-muted-foreground/90"
        )}
      >
        {label}
      </p>
    </div>
  );
}
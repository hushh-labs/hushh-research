"use client";

import { cn } from "@/lib/utils";

export const marketCardClassName = cn(
  "bg-[color:var(--app-card-surface-default-solid)]",
  "shadow-[var(--app-card-shadow-standard)]"
);

export const marketInsetClassName = cn(
  "bg-[color:var(--app-card-surface-compact)]",
  "text-foreground shadow-[var(--shadow-xs)]"
);

export const marketMicroSurfaceClassName = cn(
  marketInsetClassName,
  "transition-[background-color,box-shadow,transform] duration-200 ease-out",
  "group-hover:bg-[color:var(--app-card-surface-default-solid)]",
  "group-hover:shadow-[var(--app-card-shadow-standard)]"
);

export const marketAmbientBackgroundClassName =
  "bg-[color:var(--background)]";

export const marketAmbientGlowClassName =
  "bg-transparent";

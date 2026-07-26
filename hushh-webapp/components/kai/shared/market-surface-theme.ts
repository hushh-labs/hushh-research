"use client";

import { cn } from "@/lib/utils";
import {
  kaiAppDisplayTitleClassName,
  kaiAppEyebrowClassName,
  kaiAppSectionTitleClassName,
} from "@/components/kai/shared/kai-typography";

// Previously shadowed the canonical --app-card-* tokens with a translucent
// glass identity local to Kai. Kai now renders the same solid card recipe as
// Profile/Consent/Feed, so this is intentionally a no-op and kept only so
// existing import sites (which spread it into their own root class names)
// don't need touching.
export const marketSurfaceVariablesClassName = "";

export const kaiPreviewEyebrowClassName =
  kaiAppEyebrowClassName;

export const kaiPreviewPageTitleClassName =
  cn("font-sans text-[color:var(--one-fg)]", kaiAppDisplayTitleClassName);

export const kaiPreviewSectionTitleClassName =
  cn("flex min-w-0 items-center gap-2.5 text-[color:var(--one-fg)]", kaiAppSectionTitleClassName);

export const kaiPreviewDockFrameClassName =
  "pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[560px] px-4 pb-[calc(10px+env(safe-area-inset-bottom))] sm:px-6";

export const kaiPreviewDockSurfaceClassName = cn(
  "relative overflow-hidden bg-white/[0.82] backdrop-blur-[18px] backdrop-saturate-[180%]",
  "shadow-[0_14px_36px_-24px_rgba(0,0,0,0.30),0_1px_2px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.72)]",
  "before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:p-px before:[background:linear-gradient(135deg,rgba(255,255,255,0.88),rgba(255,255,255,0.22)_52%,rgba(0,0,0,0.08))]",
  "before:[-webkit-mask:linear-gradient(#000_0_0)_content-box,linear-gradient(#000_0_0)] before:[-webkit-mask-composite:xor] before:[mask-composite:exclude]",
  "dark:bg-[#1c1c1e]/80 dark:shadow-[0_16px_40px_-22px_rgba(0,0,0,0.78),inset_0_1px_0_rgba(255,255,255,0.12)]",
  "[&>*]:relative [&>*]:z-[1]"
);

export const kaiPreviewDockItemClassName =
  "flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-full border-0 bg-transparent px-0 pb-[5px] pt-[6px] text-[10px] font-medium tracking-normal text-[color:var(--one-fg2)] no-underline transition-[background,color,box-shadow,transform] duration-200 hover:text-[color:var(--one-fg)] active:scale-[0.93]";

export const kaiPreviewDockActiveItemClassName =
  "bg-white text-[color:var(--one-blue)] shadow-[0_10px_26px_-18px_rgba(0,0,0,0.34),0_1px_2px_rgba(0,0,0,0.08)] dark:bg-white/[0.12]";

export const marketCardClassName = cn(
  "relative isolate border border-transparent",
  "bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)]",
  "transition-[background-color,box-shadow,transform] duration-200 ease-out"
);

export const marketInsetClassName = cn(
  "border border-transparent bg-[color:var(--app-card-surface-compact)]",
  "text-foreground shadow-[var(--shadow-xs)]"
);

export const marketMicroSurfaceClassName = cn(
  marketInsetClassName,
  "transition-[background-color,box-shadow,transform] duration-200 ease-out",
  "group-hover:bg-[color:var(--app-card-surface-default-solid)]",
  "group-hover:shadow-[var(--app-card-shadow-standard)]"
);

export const marketControlClassName = cn(
  "border border-transparent bg-[color:var(--app-card-surface-compact)]",
  "shadow-[var(--shadow-xs)]"
);

export const marketSettingsGroupClassName = cn(
  "[&>div:last-child]:shadow-[var(--app-card-shadow-standard)]"
);

export const marketAmbientBackgroundClassName =
  "bg-[color:var(--background)]";

export const marketAmbientGlowClassName =
  "bg-[linear-gradient(180deg,rgba(0,113,227,0.10)_0%,rgba(52,199,89,0.045)_42%,rgba(255,149,0,0.025)_68%,transparent_100%)] dark:bg-[linear-gradient(180deg,rgba(10,132,255,0.16)_0%,rgba(48,176,199,0.08)_48%,transparent_100%)]";

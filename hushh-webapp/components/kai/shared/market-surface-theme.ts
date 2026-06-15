"use client";

import { cn } from "@/lib/utils";

export const marketSurfaceVariablesClassName = cn(
  "[--app-card-surface-default-solid:rgba(255,255,255,0.68)]",
  "[--app-card-surface-compact:rgba(255,255,255,0.48)]",
  "[--app-card-border-standard:rgba(255,255,255,0.58)]",
  "[--app-card-border-strong:rgba(255,255,255,0.72)]",
  "[--app-card-shadow-standard:0_18px_48px_-28px_rgba(0,0,0,0.34),0_5px_18px_-12px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.72)]",
  "[--app-card-shadow-feature:0_24px_62px_-34px_rgba(0,0,0,0.42),0_8px_24px_-16px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.78)]",
  "dark:[--app-card-surface-default-solid:rgba(24,24,28,0.58)]",
  "dark:[--app-card-surface-compact:rgba(255,255,255,0.10)]",
  "dark:[--app-card-border-standard:rgba(255,255,255,0.12)]",
  "dark:[--app-card-border-strong:rgba(255,255,255,0.18)]",
  "dark:[--app-card-shadow-standard:0_20px_58px_-30px_rgba(0,0,0,0.86),0_8px_24px_-18px_rgba(0,0,0,0.72),inset_0_1px_0_rgba(255,255,255,0.10)]",
  "dark:[--app-card-shadow-feature:0_26px_72px_-34px_rgba(0,0,0,0.92),0_12px_28px_-20px_rgba(0,0,0,0.76),inset_0_1px_0_rgba(255,255,255,0.12)]"
);

export const kaiPreviewEyebrowClassName =
  "text-[11px] font-medium uppercase tracking-[0.16em]";

export const kaiPreviewPageTitleClassName =
  "font-sans !text-[34px] !font-medium !leading-[1.06] !tracking-normal text-[color:var(--one-fg)] sm:!text-[40px]";

export const kaiPreviewSectionTitleClassName =
  "flex min-w-0 items-center gap-2.5 !text-[22px] !font-medium !leading-[1.08] !tracking-normal text-[color:var(--one-fg)] sm:!text-[24px]";

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
  marketSurfaceVariablesClassName,
  "relative isolate ring-1 ring-white/55 backdrop-blur-[22px] backdrop-saturate-[180%]",
  "bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)]",
  "transition-[background-color,box-shadow,transform] duration-200 ease-out",
  "dark:ring-white/10"
);

export const marketInsetClassName = cn(
  marketSurfaceVariablesClassName,
  "border border-white/55 bg-[color:var(--app-card-surface-compact)]",
  "text-foreground shadow-[0_10px_28px_-22px_rgba(0,0,0,0.30),inset_0_1px_0_rgba(255,255,255,0.68)]",
  "backdrop-blur-[18px] backdrop-saturate-[170%]",
  "dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
);

export const marketMicroSurfaceClassName = cn(
  marketInsetClassName,
  "transition-[background-color,box-shadow,transform] duration-200 ease-out",
  "group-hover:bg-[color:var(--app-card-surface-default-solid)]",
  "group-hover:shadow-[var(--app-card-shadow-standard)]"
);

export const marketControlClassName = cn(
  marketSurfaceVariablesClassName,
  "border border-white/55 bg-[color:var(--app-card-surface-compact)]",
  "shadow-[0_12px_34px_-24px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.70)]",
  "backdrop-blur-[18px] backdrop-saturate-[180%]",
  "dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.10)]"
);

export const marketSettingsGroupClassName = cn(
  marketSurfaceVariablesClassName,
  "[&>div:last-child]:ring-1 [&>div:last-child]:ring-white/55",
  "[&>div:last-child]:backdrop-blur-[22px] [&>div:last-child]:backdrop-saturate-[180%]",
  "[&>div:last-child]:shadow-[var(--app-card-shadow-standard)]",
  "dark:[&>div:last-child]:ring-white/10"
);

export const marketAmbientBackgroundClassName =
  "bg-[color:var(--background)]";

export const marketAmbientGlowClassName =
  "bg-[linear-gradient(180deg,rgba(0,113,227,0.10)_0%,rgba(52,199,89,0.045)_42%,rgba(255,149,0,0.025)_68%,transparent_100%)] dark:bg-[linear-gradient(180deg,rgba(10,132,255,0.16)_0%,rgba(48,176,199,0.08)_48%,transparent_100%)]";

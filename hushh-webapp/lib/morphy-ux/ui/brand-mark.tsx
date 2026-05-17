"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

const BRAND_MARK_SIZE_CLASSES = {
  sm: "h-[72px] w-[72px] rounded-[20px] text-[30px]",
  md: "h-24 w-24 rounded-[24px] text-[36px]",
  lg: "h-[112px] w-[112px] rounded-[28px] text-[42px]",
} as const;

export type BrandMarkSize = keyof typeof BRAND_MARK_SIZE_CLASSES;

export function BrandMark({
  label = "🤫",
  size = "md",
  className,
}: {
  label?: string;
  size?: BrandMarkSize;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "grid place-items-center bg-black text-white dark:bg-white dark:text-black",
        "font-black tracking-tight shadow-[0_18px_50px_rgba(0,0,0,0.18)]",
        BRAND_MARK_SIZE_CLASSES[size],
        className,
      )}
    >
      <span className="leading-none">{label}</span>
    </div>
  );
}

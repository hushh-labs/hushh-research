"use client";

import * as React from "react";
import type { LucideIcon, LucideProps } from "lucide-react";

import { cn } from "@/lib/utils";

export const ICON_SIZES_PX = {
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 28,
} as const;

export type IconSize = keyof typeof ICON_SIZES_PX | number;

export type IconProps = Omit<LucideProps, "size" | "strokeWidth"> & {
  icon: LucideIcon;
  size?: IconSize;
  /**
   * Rare escape hatch. Do NOT use for normal sizing; global default is controlled via
   * `--lucide-stroke-width` in `app/globals.css`.
   *
   * Implemented via CSS var override (not SVG strokeWidth prop) to avoid fighting global CSS.
   */
  strokeWidth?: number;
};

/**
 * Lucide icon wrapper.
 *
 * Design-system rules:
 * - Size icons via `size` (Lucide prop) instead of Tailwind `h-<n>/w-<n>` sizing.
 * - Keep global stroke width controlled by CSS var; override rarely via `strokeWidth`.
 */
export function Icon({
  icon: IconComponent,
  size = "md",
  strokeWidth,
  className,
  style,
  ...props
}: IconProps) {
  const px = typeof size === "number" ? size : ICON_SIZES_PX[size];

  const mergedStyle =
    strokeWidth === undefined
      ? style
      : ({
          ...(style ?? {}),
          // CSS custom prop for global Lucide stroke control
          ["--lucide-stroke-width" as any]: strokeWidth,
        } as React.CSSProperties);

  return (
    <IconComponent
      size={px}
      className={cn("shrink-0", className)}
      style={mergedStyle}
      {...props}
    />
  );
}

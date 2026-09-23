"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export const ICON_SIZES_PX = {
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 28,
} as const;

export type IconSize = keyof typeof ICON_SIZES_PX | number;

export type IconProps = Omit<React.SVGProps<SVGSVGElement>, "size" | "strokeWidth" | "ref"> & {
  icon: React.ComponentType<any>;
  size?: IconSize;
  color?: string;
  weight?: string;
  /**
   * Accepted for compatibility with older icon call sites. Canonical Phosphor
   * geometry owns its own stroke/weight treatment, so new surfaces should use
   * `weight` and the registry defaults instead.
   */
  strokeWidth?: React.SVGProps<SVGSVGElement>["strokeWidth"];
};

/**
 * Canonical icon wrapper.
 *
 * Design-system rules:
 * - Size icons via `size` instead of Tailwind `h-<n>/w-<n>` sizing when the
 *   wrapper owns the icon geometry.
 * - Keep icon weight controlled by the canonical registry; do not invent
 *   per-surface stroke treatments.
 */
export function Icon({
  icon: IconComponent,
  size = "md",
  strokeWidth: _strokeWidth,
  className,
  ...props
}: IconProps) {
  const px = typeof size === "number" ? size : ICON_SIZES_PX[size];

  return (
    <IconComponent
      size={px}
      className={cn("shrink-0", className)}
      {...props}
      data-canonical-icon="true"
    />
  );
}

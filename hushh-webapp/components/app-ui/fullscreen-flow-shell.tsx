"use client";

import type { ComponentPropsWithoutRef, ElementType } from "react";

import { cn } from "@/lib/utils";

export type FullscreenFlowShellWidth = "narrow" | "content" | "wide" | "profile";

const WIDTH_CLASS_MAP: Record<FullscreenFlowShellWidth, string> = {
  narrow: "max-w-xl",
  content: "max-w-4xl",
  wide: "max-w-5xl",
  profile: "max-w-[860px]",
};

type FullscreenFlowShellProps<T extends ElementType> = {
  as?: T;
  width?: FullscreenFlowShellWidth;
} & Omit<ComponentPropsWithoutRef<T>, "as">;

export function FullscreenFlowShell<T extends ElementType = "main">({
  as,
  width = "content",
  className,
  ...props
}: FullscreenFlowShellProps<T>) {
  const Component = as ?? "main";

  return (
    <Component
      className={cn(
        "fullscreen-flow-shell mx-auto flex w-full flex-col",
        WIDTH_CLASS_MAP[width],
        className
      )}
      data-fullscreen-flow-shell="true"
      data-top-content-anchor="true"
      {...props}
    />
  );
}

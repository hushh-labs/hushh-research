"use client";

import type { ComponentPropsWithoutRef, ElementType } from "react";

import { cn } from "@/lib/utils";

export type FullscreenFlowShellWidth =
  | "reading"
  | "standard"
  | "expanded"
  | "narrow"
  | "content"
  | "wide"
  | "profile";

const WIDTH_CLASS_MAP: Record<FullscreenFlowShellWidth, string> = {
  reading: "54rem",
  standard: "90rem",
  expanded: "96rem",
  narrow: "54rem",
  content: "90rem",
  wide: "96rem",
  profile: "54rem",
};

type FullscreenFlowShellProps<T extends ElementType> = {
  as?: T;
  width?: FullscreenFlowShellWidth;
} & Omit<ComponentPropsWithoutRef<T>, "as">;

export function FullscreenFlowShell<T extends ElementType = "main">({
  as,
  width = "standard",
  className,
  style,
  ...props
}: FullscreenFlowShellProps<T>) {
  const Component = as ?? "main";

  return (
    <Component
      className={cn(
        "fullscreen-flow-shell mx-auto flex w-full flex-col",
        className
      )}
      style={{ maxWidth: WIDTH_CLASS_MAP[width], ...style }}
      data-fullscreen-flow-shell-width={width}
      data-fullscreen-flow-shell="true"
      data-top-content-anchor="true"
      {...props}
    />
  );
}

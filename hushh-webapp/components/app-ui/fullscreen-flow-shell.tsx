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

// 1. Mapped directly to Tailwind classes instead of raw string values
export const FULLSCREEN_SHELL_MAX_WIDTHS: Record<FullscreenFlowShellWidth, string> = {
  reading: "max-w-[54rem]",
  narrow: "max-w-[54rem]",
  profile: "max-w-[54rem]",
  standard: "max-w-[90rem]",
  content: "max-w-[90rem]",
  expanded: "max-w-[96rem]",
  wide: "max-w-[96rem]",
};

type FullscreenFlowShellProps<T extends ElementType> = {
  as?: T;
  width?: FullscreenFlowShellWidth;
} & Omit<ComponentPropsWithoutRef<T>, "as">;

export function FullscreenFlowShell<T extends ElementType = "main">({
  as,
  width = "standard",
  className,
  ...props
}: FullscreenFlowShellProps<T>) {
  const Component = as ?? "main";

  return (
    <Component
      className={cn(
        "fullscreen-flow-shell mx-auto flex w-full flex-col",
        FULLSCREEN_SHELL_MAX_WIDTHS[width], // 2. Utilizing native Tailwind classes
        className
      )}
      data-fullscreen-flow-shell-width={width}
      data-fullscreen-flow-shell="true"
      data-top-content-anchor="true"
      {...props}
    />
  );
}
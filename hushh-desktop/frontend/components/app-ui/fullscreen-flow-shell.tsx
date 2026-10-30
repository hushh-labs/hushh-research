"use client";

import type { ComponentPropsWithoutRef, ElementType } from "react";
import { XIcon } from "lucide-react";

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
  onClose?: () => void;
  closeLabel?: string;
} & Omit<ComponentPropsWithoutRef<T>, "as">;

export function FullscreenFlowShell<T extends ElementType = "main">({
  as,
  width = "standard",
  onClose,
  closeLabel = "Close",
  className,
  children,
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
    >
      {onClose ? (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex size-10 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm ring-1 ring-border/70 backdrop-blur transition hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      {children}
    </Component>
  );
}

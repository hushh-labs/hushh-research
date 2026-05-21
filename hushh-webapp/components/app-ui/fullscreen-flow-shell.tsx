import type { ComponentPropsWithoutRef, ElementType } from "react";

import { cn } from "@/lib/utils";

// =============================================================================
// STRUCTURAL CONSTANTS & TWILLIND MATRIX MAPS
// =============================================================================

export type FullscreenFlowShellWidth =
  | "reading"
  | "standard"
  | "expanded"
  | "narrow"
  | "content"
  | "wide"
  | "profile";

// Replaced raw pixel/rem string injection markers with native responsive Tailwind utility classes
export const FULLSCREEN_FLOW_MAX_WIDTHS: Record<FullscreenFlowShellWidth, string> = {
  reading: "max-w-[54rem]",
  narrow: "max-w-[54rem]",
  profile: "max-w-[54rem]",
  standard: "max-w-[90rem]",
  content: "max-w-[90rem]",
  expanded: "max-w-[96rem]",
  wide: "max-w-[96rem]",
};

export const FULLSCREEN_FLOW_FRAME_CLASSNAME = 
  "mx-auto flex w-full flex-col px-[var(--page-inline-gutter-standard,1rem)] md:px-[var(--page-inline-gutter-desktop,2rem)] min-h-screen grow";

// =============================================================================
// POLYMORPHIC TYPE CONSTRAINTS GENERATION
// =============================================================================

type PolymorphicProps<T extends ElementType, Props = {}> = Props & {
  as?: T;
} & Omit<ComponentPropsWithoutRef<T>, "as" | keyof Props>;

type FullscreenFlowShellProps<T extends ElementType> = PolymorphicProps<T, {
  width?: FullscreenFlowShellWidth;
  scrollSnap?: boolean; // New Feature: Toggle structural section-based mobile viewport snapping
}>;

// =============================================================================
// MAIN COMPONENT EXPORT NODE (React Server Component)
// =============================================================================

export function FullscreenFlowShell<T extends ElementType = "main">({
  as,
  width = "standard",
  scrollSnap = false,
  className,
  id,
  ...props
}: FullscreenFlowShellProps<T>) {
  const Component = as ?? "main";

  return (
    <Component
      id={id ?? "fullscreen-flow-root-container"} // Accessibility anchor tag matching standard browser skiplinks
      className={cn(
        "fullscreen-flow-shell",
        FULLSCREEN_FLOW_FRAME_CLASSNAME,
        FULLSCREEN_FLOW_MAX_WIDTHS[width],
        scrollSnap ? "h-screen overflow-y- those snap-y snap-mandatory scroll-smooth" : "",
        className
      )}
      data-fullscreen-flow-shell-width={width}
      data-fullscreen-flow-shell="true"
      data-top-content-anchor="true"
      {...props}
    />
  );
}

// =============================================================================
// COMPANION VIEWPORT SUB-REGION MODULE SLOTS
// =============================================================================

export function FullscreenFlowSection<T extends ElementType = "section">({
  as,
  className,
  ...props
}: PolymorphicProps<T>) {
  const Component = as ?? "section";

  return (
    <Component
      className={cn(
        "fullscreen-flow-section w-full shrink-0 flex flex-col justify-center snap-start py-8 md:py-16",
        className
      )}
      {...props}
    />
  );
}
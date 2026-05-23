import type { ComponentPropsWithoutRef, ElementType, CSSProperties } from "react";

import {
  NativeTestBeacon,
  type NativeTestAuthState,
  type NativeTestDataState,
} from "@/components/app-ui/native-test-beacon";
import { cn } from "@/lib/utils";

// =============================================================================
// LEGACY COMPATIBILITY EXPORTS (Restored to fix TS2305 error blocks)
// =============================================================================

export const APP_SHELL_FRAME_STYLE: CSSProperties = {
  maxWidth: "90rem",
};

export const APP_MEASURE_STYLES: Record<"reading" | "standard" | "expanded", CSSProperties> = {
  reading: { maxWidth: "54rem" },
  standard: { maxWidth: "90rem" },
  expanded: { maxWidth: "96rem" },
} as const;

// =============================================================================
// MODERN TAILWIND CONSTANTS & CONFIGURATIONS
// =============================================================================

export type AppPageShellWidth =
  | "reading"
  | "standard"
  | "expanded"
  | "narrow"
  | "content"
  | "wide"
  | "profile";

export type AppPageDensity = "compact" | "comfortable";

export const APP_SHELL_MAX_WIDTHS: Record<AppPageShellWidth, string> = {
  reading: "max-w-[54rem]",
  narrow: "max-w-[54rem]",
  profile: "max-w-[54rem]",
  standard: "max-w-[90rem]",
  content: "max-w-[90rem]",
  expanded: "max-w-[96rem]",
  wide: "max-w-[96rem]",
};

export const APP_SHELL_FRAME_CLASSNAME =
  "mx-auto w-full px-[var(--page-inline-gutter-standard,1rem)] md:px-[var(--page-inline-gutter-desktop,2rem)]";

// =============================================================================
// POLYMORPHIC TYPE CONSTRAINTS DEFINITIONS
// =============================================================================

type PolymorphicProps<T extends ElementType, Props = {}> = Props & {
  as?: T;
} & Omit<ComponentPropsWithoutRef<T>, "as" | keyof Props>;

type AppPageShellProps<T extends ElementType> = PolymorphicProps<T, {
  width?: AppPageShellWidth;
  density?: AppPageDensity;
  nativeTest?: {
    routeId: string;
    marker: string;
    authState: NativeTestAuthState;
    dataState: NativeTestDataState;
    errorCode?: string | null;
    errorMessage?: string | null;
  };
}>;

type AppPageRegionProps<T extends ElementType> = PolymorphicProps<T, {
  nestedLayout?: boolean;
}>;

// =============================================================================
// MAIN COMPONENT MODULE IMPLEMENTATIONS
// =============================================================================

export function AppPageShell<T extends ElementType = "main">({
  as,
  width = "standard",
  density = "compact",
  nativeTest,
  className,
  children,
  id,
  ...props
}: AppPageShellProps<T>) {
  const Component = as ?? "main";

  return (
    <Component
      id={id ?? "main-application-content"} // Anchor point for standard accessibility skiplinks
      className={cn(
        "app-page-shell flex flex-col w-full min-h-screen grow",
        APP_SHELL_FRAME_CLASSNAME,
        APP_SHELL_MAX_WIDTHS[width],
        density === "compact" ? "gap-4 py-4 md:py-6" : "gap-6 py-6 md:py-10",
        className
      )}
      data-app-density={density}
      data-app-shell-width={width}
      data-top-content-anchor="true"
      {...props}
    >
      {nativeTest ? <NativeTestBeacon {...nativeTest} /> : null}
      {children}
    </Component>
  );
}

export function AppPageHeaderRegion<T extends ElementType = "div">({
  as,
  className,
  ...props
}: AppPageRegionProps<T>) {
  const Component = as ?? "div";

  return (
    <Component
      className={cn(
        "app-page-header-region w-full min-w-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/40 pb-4", 
        className
      )}
      {...props}
    />
  );
}

export function AppPageContentRegion<T extends ElementType = "div">({
  as,
  nestedLayout = false,
  className,
  ...props
}: AppPageRegionProps<T>) {
  const Component = as ?? "div";

  return (
    <Component
      className={cn(
        "app-page-content-region w-full min-w-0 flex-1", 
        nestedLayout ? "grid grid-cols-1 lg:grid-cols-12 gap-6 items-start" : "flex flex-col gap-4",
        className
      )}
      {...props}
    />
  );
}

// =============================================================================
// DASHBOARD SUB-REGIONS
// =============================================================================

export function AppPageSidebarRegion<T extends ElementType = "aside">({
  as,
  className,
  ...props
}: AppPageRegionProps<T>) {
  const Component = as ?? "aside";

  return (
    <Component
      className={cn(
        "app-page-sidebar-region w-full min-w-0 lg:col-span-3 xl:col-span-2 border-b lg:border-b-0 lg:border-r border-border/40 pb-4 lg:pb-0 lg:pr-4",
        className
      )}
      {...props}
    />
  );
}

export function AppPageFooterRegion<T extends ElementType = "footer">({
  as,
  className,
  ...props
}: AppPageRegionProps<T>) {
  const Component = as ?? "footer";

  return (
    <Component
      className={cn(
        "app-page-footer-region w-full min-w-0 mt-auto border-t border-border/40 pt-4 text-xs text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}
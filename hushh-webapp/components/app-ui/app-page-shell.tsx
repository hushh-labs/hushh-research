// 1. Removed "use client" so this becomes a React Server Component (RSC)

import type { ComponentPropsWithoutRef, ElementType, CSSProperties } from "react";

import {
  NativeTestBeacon,
  type NativeTestAuthState,
  type NativeTestDataState,
} from "@/components/app-ui/native-test-beacon";
import type { PolymorphicTag } from "@/lib/morphy-ux/polymorphic";
import { cn } from "@/lib/utils";

export type AppPageShellWidth =
  | "reading"
  | "agent"
  | "standard"
  | "expanded"
  | "narrow"
  | "content"
  | "wide"
  | "profile";

export type AppPageDensity = "compact" | "comfortable";

// 2. Mapped directly to Tailwind classes instead of raw string values
export const APP_SHELL_MAX_WIDTHS: Record<AppPageShellWidth, string> = {
  reading: "max-w-[720px]",
  agent: "max-w-[880px]",
  narrow: "max-w-[720px]",
  profile: "max-w-[720px]",
  standard: "max-w-[90rem]",
  content: "max-w-[90rem]",
  expanded: "max-w-[96rem]",
  wide: "max-w-[96rem]",
};

export const APP_SHELL_FRAME_CLASSNAME =
  "mx-auto w-full px-[var(--page-inline-gutter-standard)]";

// Kept for backward compatibility if imported in other files
export const APP_SHELL_FRAME_STYLE: CSSProperties = {
  maxWidth: "90rem",
};

export const APP_MEASURE_STYLES: Record<"reading" | "standard" | "expanded", CSSProperties> = {
  reading: { maxWidth: "54rem" },
  standard: { maxWidth: "90rem" },
  expanded: { maxWidth: "96rem" },
} as const;

type AppPageShellProps<T extends ElementType> = {
  as?: T;
  width?: AppPageShellWidth;
  density?: AppPageDensity;
  /**
   * Let the page height fit its content instead of being stretched to fill the
   * viewport. Sparse screens (empty states, short lists) otherwise force a
   * full-height shell, producing a large dead scroll region above the floating
   * "Talk to One" bar. Opt-in so content-rich pages that anchor a bottom
   * element to the viewport are unaffected.
   */
  fitContent?: boolean;

  nativeTest?: {
    routeId: string;
    marker: string;
    authState: NativeTestAuthState;
    dataState: NativeTestDataState;
    errorCode?: string | null;
    errorMessage?: string | null;
  };
} & Omit<ComponentPropsWithoutRef<T>, "as">;

type AppPageRegionProps<T extends ElementType> = {
  as?: T;
} & Omit<ComponentPropsWithoutRef<T>, "as">;

export function AppPageShell<T extends ElementType = "main">({
  as,
  width = "standard",
  density = "compact",
  fitContent = false,
  nativeTest,
  className,
  children,
  ...props
}: AppPageShellProps<T>) {
  const Component = (as ?? "main") as PolymorphicTag;

  return (
    <Component
      className={cn(
        "app-page-shell",
        APP_SHELL_FRAME_CLASSNAME, // 3. Added the missing framing class
        APP_SHELL_MAX_WIDTHS[width], // 4. Utilizing Tailwind utility classes over inline styles
        fitContent && "app-page-shell--fit-content",
        className
      )}
      data-app-density={density}
      data-app-shell-width={width}
      data-app-shell-fit-content={fitContent ? "true" : undefined}
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
  const Component = (as ?? "div") as PolymorphicTag;

  return (
    <Component
      className={cn("app-page-header-region w-full min-w-0", className)}
      {...props}
    />
  );
}

export function AppPageContentRegion<T extends ElementType = "div">({
  as,
  className,
  ...props
}: AppPageRegionProps<T>) {
  const Component = (as ?? "div") as PolymorphicTag;

  return (
    <Component
      className={cn("app-page-content-region w-full min-w-0", className)}
      {...props}
    />
  );
}

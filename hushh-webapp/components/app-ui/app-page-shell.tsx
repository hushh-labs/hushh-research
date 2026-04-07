"use client";

import type { ComponentPropsWithoutRef, ElementType } from "react";
import type { CSSProperties } from "react";

import {
  NativeTestBeacon,
  type NativeTestAuthState,
  type NativeTestDataState,
} from "@/components/app-ui/native-test-beacon";
import { cn } from "@/lib/utils";

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
  reading: "54rem",
  standard: "90rem",
  expanded: "96rem",
  narrow: "54rem",
  content: "90rem",
  wide: "96rem",
  profile: "54rem",
};

export const APP_SHELL_FRAME_CLASSNAME =
  "mx-auto w-full px-[var(--page-inline-gutter-standard)]";

export const APP_SHELL_FRAME_STYLE: CSSProperties = {
  maxWidth: APP_SHELL_MAX_WIDTHS.standard,
};

export const APP_MEASURE_STYLES: Record<"reading" | "standard" | "expanded", CSSProperties> = {
  reading: { maxWidth: APP_SHELL_MAX_WIDTHS.reading },
  standard: { maxWidth: APP_SHELL_MAX_WIDTHS.standard },
  expanded: { maxWidth: APP_SHELL_MAX_WIDTHS.expanded },
} as const;

type AppPageShellProps<T extends ElementType> = {
  as?: T;
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
} & Omit<ComponentPropsWithoutRef<T>, "as">;

type AppPageRegionProps<T extends ElementType> = {
  as?: T;
} & Omit<ComponentPropsWithoutRef<T>, "as">;

export function AppPageShell<T extends ElementType = "main">({
  as,
  width = "standard",
  density = "compact",
  nativeTest,
  className,
  style,
  children,
  ...props
}: AppPageShellProps<T>) {
  const Component = as ?? "main";

  return (
    <Component
      className={cn(
        "app-page-shell mx-auto w-full",
        className
      )}
      style={{ maxWidth: APP_SHELL_MAX_WIDTHS[width], ...style }}
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
  const Component = as ?? "div";

  return (
    <Component
      className={cn("app-page-content-region w-full min-w-0", className)}
      {...props}
    />
  );
}

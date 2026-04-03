"use client";

import type { ComponentPropsWithoutRef, ElementType } from "react";

import {
  NativeTestBeacon,
  type NativeTestAuthState,
  type NativeTestDataState,
} from "@/components/app-ui/native-test-beacon";
import { cn } from "@/lib/utils";

export type AppPageShellWidth = "narrow" | "content" | "wide" | "profile";
export type AppPageDensity = "compact" | "comfortable";

const WIDTH_CLASS_MAP: Record<AppPageShellWidth, string> = {
  narrow: "max-w-xl",
  content: "max-w-4xl",
  wide: "max-w-5xl",
  profile: "max-w-[860px]",
};

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
  width = "content",
  density = "compact",
  nativeTest,
  className,
  children,
  ...props
}: AppPageShellProps<T>) {
  const Component = as ?? "main";

  return (
    <Component
      className={cn(
        "app-page-shell mx-auto w-full",
        WIDTH_CLASS_MAP[width],
        className
      )}
      data-app-density={density}
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

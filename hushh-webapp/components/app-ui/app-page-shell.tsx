"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactNode,
  type CSSProperties
} from "react";
import { NativeTestBeacon, type NativeTestAuthState, type NativeTestDataState } from "@/components/app-ui/native-test-beacon";
import { cn } from "@/lib/utils";

/**
 * Shell Configuration & Performance Tokens
 */
export type AppPageShellWidth = "reading" | "standard" | "expanded" | "narrow" | "content" | "wide" | "profile";
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

/** 
 * Lightweight context to allow child components to check shell state 
 * without re-rendering the entire page tree.
 */
const ShellContext = createContext<{ scrolled: boolean; width: AppPageShellWidth }>({
  scrolled: false,
  width: "standard"
});

export const useShellState = () => useContext(ShellContext);

interface AppPageRegionProps<T extends ElementType> {
  as?: T;
  children?: ReactNode;
  className?: string;
}

/**
 * High-Efficiency AppPageShell
 * Features: 
 * 1. Intersection-free scroll tracking for header effects.
 * 2. Optimized CSS Variable injection for layout stability.
 * 3. Atomic region rendering to prevent layout shifts.
 */
export function AppPageShell<T extends ElementType = "main">({
  as,
  width = "standard",
  density = "compact",
  nativeTest,
  className,
  style,
  children,
  ...props
}: {
  as?: T;
  width?: AppPageShellWidth;
  density?: AppPageDensity;
  nativeTest?: {
    routeId: string;
    marker: string;
    authState: NativeTestAuthState;
    dataState: NativeTestDataState;
  };
} & Omit<ComponentPropsWithoutRef<T>, "as">) {
  const Component = as ?? "main";
  const [scrolled, setScrolled] = useState(false);

  // Passive scroll listener for better performance on mobile devices
  useEffect(() => {
    const handleScroll = () => {
      const isScrolled = window.scrollY > 20;
      if (isScrolled !== scrolled) setScrolled(isScrolled);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [scrolled]);

  return (
    <ShellContext.Provider value={{ scrolled, width }}>
      <Component
        className={cn(
          "app-page-shell relative mx-auto w-full transition-all duration-300",
          scrolled ? "shell-scrolled" : "shell-top",
          className
        )}
        style={{
          "--shell-max-width": APP_SHELL_MAX_WIDTHS[width],
          maxWidth: "var(--shell-max-width)",
          ...style
        } as CSSProperties}
        data-app-density={density}
        data-app-shell-width={width}
        data-scrolled={scrolled}
        data-top-content-anchor="true"
        {...props}
      >
        {nativeTest && <NativeTestBeacon {...nativeTest} />}
        <div className="flex flex-col min-h-screen">
          {children}
        </div>
      </Component>
    </ShellContext.Provider>
  );
}

export function AppPageHeaderRegion<T extends ElementType = "div">({
  as,
  className,
  ...props
}: AppPageRegionProps<T> & Omit<ComponentPropsWithoutRef<T>, "as">) {
  const Component = as ?? "div";
  const { scrolled } = useShellState();

  return (
    <Component
      className={cn(
        "app-page-header-region sticky top-0 z-40 w-full min-w-0 transition-shadow",
        scrolled ? "bg-background/80 backdrop-blur-md border-b" : "bg-transparent",
        className
      )}
      data-scrolled={scrolled}
      {...props}
    />
  );
}

export function AppPageContentRegion<T extends ElementType = "div">({
  as,
  className,
  ...props
}: AppPageRegionProps<T> & Omit<ComponentPropsWithoutRef<T>, "as">) {
  const Component = as ?? "div";
  return (
    <Component
      className={cn(
        "app-page-content-region flex-1 w-full min-w-0 px-[var(--page-inline-gutter-standard)]",
        className
      )}
      {...props}
    />
  );
}
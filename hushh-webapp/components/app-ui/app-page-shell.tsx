"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useMemo,
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

export const APP_SHELL_FRAME_CLASSNAME = "mx-auto w-full px-[var(--page-inline-gutter-standard)]";

export const APP_SHELL_FRAME_STYLE: React.CSSProperties = {
  maxWidth: "var(--shell-max-width, 90rem)",
};

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
    errorCode?: string | null;
    errorMessage?: string | null;
  };
} & Omit<ComponentPropsWithoutRef<T>, "as">) {
  const Component = as ?? "main";
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    // Only update state if the boolean value actually changes
    const handleScroll = () => {
      const isScrolled = window.scrollY > 20;
      setScrolled((prev) => (prev !== isScrolled ? isScrolled : prev));
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Memoize context to prevent unnecessary re-renders of consuming components
  const contextValue = useMemo(() => ({ scrolled, width }), [scrolled, width]);

  const shellStyles = useMemo(() => ({
    "--shell-max-width": APP_SHELL_MAX_WIDTHS[width],
    maxWidth: "var(--shell-max-width)",
    ...style
  } as CSSProperties), [width, style]);

  return (
    <ShellContext.Provider value={contextValue}>
      <Component
        className={cn("app-page-shell relative mx-auto w-full transition-all", className)}
        style={shellStyles}
        data-app-density={density}
        data-app-shell-width={width}
        data-scrolled={scrolled}
        data-top-content-anchor="true"
        {...props}
      >
        {nativeTest && <NativeTestBeacon {...nativeTest} />}
        {children}
      </Component>
    </ShellContext.Provider>
  );
}

/**
 * Shared Region Component Logic
 */
function AppPageRegion<T extends ElementType = "div">({
  as,
  className,
  baseClass,
  ...props
}: AppPageRegionProps<T> & Omit<ComponentPropsWithoutRef<T>, "as"> & { baseClass: string }) {
  const Component = as ?? "div";
  return <Component className={cn(baseClass, "w-full min-w-0", className)} {...props} />;
}

export const AppPageHeaderRegion = <T extends ElementType = "div">(props: AppPageRegionProps<T> & Omit<ComponentPropsWithoutRef<T>, "as">) => (
  <AppPageRegion {...props} baseClass="app-page-header-region" />
);

export const AppPageContentRegion = <T extends ElementType = "div">(props: AppPageRegionProps<T> & Omit<ComponentPropsWithoutRef<T>, "as">) => (
  <AppPageRegion {...props} baseClass="app-page-content-region" />
);
"use client";

import { useEffect, useRef } from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import type { ThemeProviderProps } from "next-themes";

export function beginThemeSwitchTransition() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.add("theme-switching");

  window.setTimeout(() => {
    root.classList.remove("theme-switching");
  }, 320);
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      <ThemeTransitionController />
      {children}
    </NextThemesProvider>
  );
}

function ThemeTransitionController() {
  const { resolvedTheme } = useTheme();
  const didMountRef = useRef(false);

  useEffect(() => {
    if (typeof document === "undefined") return;

    // Skip first paint to avoid startup flash during hydration.
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }

    const root = document.documentElement;
    // If a control pre-started the transition (before setTheme), avoid double-triggering.
    if (root.classList.contains("theme-switching")) {
      return;
    }
    root.classList.add("theme-switching");

    const timeout = window.setTimeout(() => {
      root.classList.remove("theme-switching");
    }, 280);

    return () => {
      window.clearTimeout(timeout);
      root.classList.remove("theme-switching");
    };
  }, [resolvedTheme]);

  return null;
}

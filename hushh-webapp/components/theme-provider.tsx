"use client";

import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import type { ThemeProviderProps } from "next-themes";

export function beginThemeSwitchTransition() {
  // No-op.
  // Theme switching is kept local to the control and shell surfaces to avoid
  // forcing whole-document transitions across the signed-in app.
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
  useTheme();
  return null;
}

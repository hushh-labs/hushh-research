"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ThemeProviderProps } from "next-themes";

/**
 * No-op function.
 * Theme switching is kept local to the control and shell surfaces to avoid
 * forcing whole-document transitions across the signed-in app.
 * * Note: If this function isn't strictly required by a shared interface or 
 * external import, it is safe to delete.
 */
export function beginThemeSwitchTransition() { }

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      {children}
    </NextThemesProvider>
  );
}

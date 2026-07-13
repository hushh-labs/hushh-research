"use client";

import { ReactNode } from "react";
import { Providers } from "./providers";

interface RootLayoutClientProps {
  children: ReactNode;
  fontClasses: string;
}

/**
 * Client-side wrapper for body element
 * Enables client-side features in root layout
 *
 * MANDATORY: Implements seamless opacity crossfade transitions at root level.
 * All route changes go through this transition system automatically.
 *
 * Note: RootLoader and RouteProgressBar are now in providers.tsx inside
 * PageLoadingProvider so they can access the loading context.
 */
export function RootLayoutClient({
  children,
  fontClasses: _fontClasses,
}: RootLayoutClientProps) {
  return (
    <>
      {/* Fixed app background surface (oversized to prevent mobile gaps). */}
      <div
        className="fixed top-[-10vh] left-0 w-full h-[120vh] -z-20 morphy-app-bg pointer-events-none"
        style={{
          backgroundColor: "var(--background)",
          backgroundImage: "none",
        }}
      />

      <Providers>{children}</Providers>
    </>
  );
}

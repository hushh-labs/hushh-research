"use client";

import { ReactNode, useEffect, useState } from "react";
import { Providers } from "./providers";
import { FocusTimerWidget } from "@/components/features/focus/focus-timer-widget";

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
  fontClasses,
}: RootLayoutClientProps) {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  return (
    <body
      suppressHydrationWarning
      className={`${fontClasses} font-sans antialiased min-h-[100dvh] flex flex-col overflow-x-hidden`}
    >
      {/* Fixed app background surface (oversized to prevent mobile gaps). */}
      <div
        className="fixed top-[-10vh] left-0 w-full h-[120vh] -z-20 morphy-app-bg pointer-events-none"
        style={{ backgroundColor: "var(--background)", backgroundImage: "none" }}
      />

      <div
        className={`flex min-h-0 flex-1 flex-col transition-opacity duration-150 ease-out ${
          hydrated ? "opacity-100" : "opacity-0"
        }`}
      >
        <Providers>
          {children}
          <FocusTimerWidget />
        </Providers>
      </div>
    </body>
  );
}

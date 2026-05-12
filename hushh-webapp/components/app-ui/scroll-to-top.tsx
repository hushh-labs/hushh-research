"use client";

import * as React from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

/**
 * Accessible Scroll-to-Top Floating Action Button (FAB)
 * * - Appears after scrolling down 400px.
 * - Fully keyboard accessible with focus rings.
 * - Respects the user's OS-level 'prefers-reduced-motion' settings.
 */
export function ScrollToTop() {
  const [isVisible, setIsVisible] = React.useState(false);

  React.useEffect(() => {
    const toggleVisibility = () => {
      if (window.scrollY > 400) {
        setIsVisible(true);
      } else {
        setIsVisible(false);
      }
    };

    // Passive listener for scroll performance
    window.addEventListener("scroll", toggleVisibility, { passive: true });
    return () => window.removeEventListener("scroll", toggleVisibility);
  }, []);

  const scrollToTop = () => {
    // A11y: Check if the user has requested reduced motion at the OS level
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    
    window.scrollTo({
      top: 0,
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  };

  return (
    <button
      type="button"
      onClick={scrollToTop}
      aria-label="Scroll to top of page"
      className={cn(
        "fixed bottom-6 right-6 z-50 rounded-full p-3 shadow-lg border border-border/50 backdrop-blur-sm",
        "bg-background/80 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "transition-all duration-300 ease-in-out",
        isVisible 
          ? "translate-y-0 opacity-100 pointer-events-auto" 
          : "translate-y-10 opacity-0 pointer-events-none"
      )}
    >
      <ArrowUp className="size-5" aria-hidden="true" />
    </button>
  );
}
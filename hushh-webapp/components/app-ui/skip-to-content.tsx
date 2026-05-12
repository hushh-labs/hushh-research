import * as React from "react";
import { cn } from "@/lib/morphy-ux/cn";

export interface SkipToContentProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  targetId?: string;
}

/**
 * WCAG 2.1 Accessibility Requirement: Keyboard Navigation
 * Visually hidden by default. Becomes visible only when focused via keyboard (Tab).
 * Allows users to bypass repetitive navigation links.
 */
export function SkipToContent({ 
  targetId = "main-content", 
  className, 
  ...props 
}: SkipToContentProps) {
  return (
    <a
      href={`#${targetId}`}
      className={cn(
        // Hidden by default, but still accessible to the DOM focus tree
        "sr-only",
        // When focused via 'Tab', it overrides sr-only and styles itself as a prominent button
        "focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100]",
        "focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground",
        "focus:rounded-md focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring",
        "transition-all duration-200 ease-in-out",
        className
      )}
      {...props}
    >
      Skip to main content
    </a>
  );
}
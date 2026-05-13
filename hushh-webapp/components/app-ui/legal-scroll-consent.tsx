"use client";

import * as React from "react";
import { cn } from "@/lib/morphy-ux/cn";
import { CheckCircle2 } from "lucide-react";

export interface LegalScrollConsentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  onReadComplete: () => void;
  containerHeight?: string;
}

/**
 * Accessible Legal Scroll Consent Container
 * Ensures users scroll through Terms of Service or Privacy Policies before proceeding.
 * Fully keyboard accessible with a visual progress indicator.
 */
export function LegalScrollConsent({
  children,
  onReadComplete,
  containerHeight = "max-h-[400px]",
  className,
  ...props
}: LegalScrollConsentProps) {
  const [progress, setProgress] = React.useState(0);
  const [hasCompleted, setHasCompleted] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const handleScroll = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    const { scrollTop, scrollHeight, clientHeight } = element;
    
    // Security Fix: Prevent auto-completion if the browser hasn't painted dimensions yet (or JSDOM)
    if (clientHeight === 0) return;

    // Calculate how far down the user has scrolled as a percentage
    const totalScrollableDistance = scrollHeight - clientHeight;
    
    // If the content is smaller than the container, they've inherently read it all
    if (totalScrollableDistance <= 0) {
      setProgress(100);
      if (!hasCompleted) {
        setHasCompleted(true);
        onReadComplete();
      }
      return;
    }

    const currentProgress = Math.min((scrollTop / totalScrollableDistance) * 100, 100);
    setProgress(currentProgress);

    // We use a 99% threshold to be forgiving of rounding errors in browser zoom levels
    if (currentProgress >= 99 && !hasCompleted) {
      setHasCompleted(true);
      onReadComplete();
    }
  }, [hasCompleted, onReadComplete]);

  // Check initial state on mount (in case content is very short)
  React.useEffect(() => {
    handleScroll();
    // Re-check if window resizes, which might change the text wrapping and height
    window.addEventListener("resize", handleScroll);
    return () => window.removeEventListener("resize", handleScroll);
  }, [handleScroll]);

  return (
    <div className={cn("relative flex flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm", className)} {...props}>
      {/* A11y: tabIndex={0} is CRITICAL here. 
        It allows keyboard users to focus the container and use Arrow keys or Spacebar to scroll.
      */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        tabIndex={0}
        aria-label="Legal terms and conditions document"
        className={cn(
          "overflow-y-auto p-6 scroll-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          containerHeight
        )}
      >
        <div className="prose prose-sm dark:prose-invert max-w-none">
          {children}
        </div>
      </div>

      {/* Footer Progress Bar area */}
      <div className="flex items-center justify-between border-t border-border/50 bg-muted/20 px-4 py-3">
        <div className="w-full max-w-[200px] h-2 bg-muted rounded-full overflow-hidden" aria-hidden="true">
          <div 
            className={cn("h-full transition-all duration-150 ease-out", hasCompleted ? "bg-emerald-500" : "bg-primary")}
            style={{ width: `${progress}%` }}
          />
        </div>
        
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground ml-4">
          {hasCompleted ? (
            <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Finished reading
            </span>
          ) : (
            <span>Scroll to bottom to accept</span>
          )}
        </div>

        {/* A11y Live Region */}
        <span className="sr-only" aria-live="polite">
          {hasCompleted ? "You have reached the end of the document. You may now accept the terms." : ""}
        </span>
      </div>
    </div>
  );
}
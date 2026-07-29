"use client";

import * as React from "react";
import { Shield } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

export interface PrivacyScreenGuardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  label?: string;
}

/**
 * Reactive Privacy Screen Guard
 * Protects highly sensitive information (Vault Keys, KYC Docs, Portfolios) from shoulder surfing.
 * Automatically blurs the content the millisecond the browser tab loses focus.
 */
export function PrivacyScreenGuard({
  children,
  label = "Screen hidden for privacy",
  className,
  ...props
}: PrivacyScreenGuardProps) {
  const [isHidden, setIsHidden] = React.useState(false);

  React.useEffect(() => {
    // Check initial state in case the component mounts while the tab is already in the background
    if (typeof document !== "undefined") {
      setIsHidden(document.hidden || !document.hasFocus());
    }

    const handleFocus = () => setIsHidden(false);
    const handleBlur = () => setIsHidden(true);
    
    const handleVisibilityChange = () => {
      if (document.hidden) setIsHidden(true);
      else if (document.hasFocus()) setIsHidden(false);
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return (
    <div className={cn("relative w-full transition-all duration-300", className)} {...props}>
      {/* The wrapped sensitive content */}
      <div
        className={cn(
          "w-full transition-all duration-300",
          isHidden ? "blur-md opacity-30 select-none pointer-events-none grayscale" : "blur-0 opacity-100"
        )}
        // A11y: Hide the blurred content from screen readers when not focused
        aria-hidden={isHidden}
      >
        {children}
      </div>

      {/* The Privacy Overlay Shield */}
      {isHidden && (
        <div 
          className="absolute inset-0 z-50 flex flex-col items-center justify-center rounded-md bg-background/10 backdrop-blur-sm animate-in fade-in zoom-in-95 duration-200"
          aria-live="polite"
        >
          <div className="flex flex-col items-center justify-center rounded-xl bg-background/90 p-4 shadow-xl border border-border/50">
            <Shield className="size-8 text-primary mb-3" aria-hidden="true" />
            <span className="text-sm font-semibold tracking-tight text-foreground text-center">
              {label}
            </span>
            <span className="text-xs text-muted-foreground mt-1 text-center">
              Click anywhere to resume
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
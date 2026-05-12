import * as React from "react";
import { cn } from "@/lib/morphy-ux/cn";
import { getSemanticLoaderProps } from "@/lib/utils/a11y-helpers";

export interface SemanticLoaderProps extends React.HTMLAttributes<HTMLDivElement> {
  loadingText?: string;
  isCritical?: boolean;
}

/**
 * SemanticLoader
 * * A visually polished skeleton state that prevents Cumulative Layout Shift (CLS).
 * Replaces generic spinners with WCAG-compliant screen-reader semantics.
 */
export function SemanticLoader({
  className,
  loadingText = "Loading content...",
  isCritical = false,
  ...props
}: SemanticLoaderProps) {
  const ariaProps = getSemanticLoaderProps(loadingText, isCritical);

  return (
    <div
      {...ariaProps}
      className={cn(
        "animate-pulse rounded-md bg-muted/50 dark:bg-muted/20 overflow-hidden",
        className
      )}
      {...props}
    >
      {/* Visually hidden text for strict screen-reader compliance */}
      <span className="sr-only">{loadingText}</span>
    </div>
  );
}
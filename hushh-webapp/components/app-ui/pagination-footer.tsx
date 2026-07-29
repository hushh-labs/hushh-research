"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

export interface PaginationFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  itemName?: string;
}

/**
 * Accessible Pagination Footer
 * Provides robust navigation for data tables and KYC document lists.
 * Features strict disabled states and aria-live announcements for screen readers.
 */
export function PaginationFooter({
  currentPage,
  totalPages,
  onPageChange,
  itemName = "results",
  className,
  ...props
}: PaginationFooterProps) {
  // Ensure we don't divide by zero or show weird negative states
  const safeCurrent = Math.max(1, Math.min(currentPage, totalPages));
  const safeTotal = Math.max(1, totalPages);

  const isFirstPage = safeCurrent === 1;
  const isLastPage = safeCurrent === safeTotal;

  return (
    <nav
      role="navigation"
      aria-label="Pagination Navigation"
      className={cn("flex items-center justify-between w-full py-3", className)}
      {...props}
    >
      {/* Mobile-friendly abbreviated text, expanding on larger screens */}
      <div className="text-sm text-muted-foreground">
        Page <span className="font-medium text-foreground">{safeCurrent}</span> of{" "}
        <span className="font-medium text-foreground">{safeTotal}</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => !isFirstPage && onPageChange(safeCurrent - 1)}
          disabled={isFirstPage}
          aria-disabled={isFirstPage}
          aria-label="Go to previous page"
          className={cn(
            "inline-flex size-9 items-center justify-center rounded-md border border-border bg-transparent p-0 transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            isFirstPage 
              ? "opacity-50 cursor-not-allowed" 
              : "hover:bg-muted hover:text-foreground"
          )}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => !isLastPage && onPageChange(safeCurrent + 1)}
          disabled={isLastPage}
          aria-disabled={isLastPage}
          aria-label="Go to next page"
          className={cn(
            "inline-flex size-9 items-center justify-center rounded-md border border-border bg-transparent p-0 transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            isLastPage 
              ? "opacity-50 cursor-not-allowed" 
              : "hover:bg-muted hover:text-foreground"
          )}
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>

      {/* A11y: Screen readers need to know when the page actually changes via a live region */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {`Showing page ${safeCurrent} of ${safeTotal} for ${itemName}.`}
      </div>
    </nav>
  );
}
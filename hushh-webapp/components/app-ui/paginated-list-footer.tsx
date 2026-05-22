"use client";

import { useMemo } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";

export interface PaginatedListFooterProps {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  onPrevious: () => void;
  onNext: () => void;
  className?: string;
  isLoading?: boolean;
}

/**
 * Deterministic helper to check if the footer provides any value to the user.
 * Now includes safety Number() conversions and handled loading state.
 */
export function shouldRenderPaginatedListFooter(params: {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}) {
  const total = Math.max(0, Number(params.total) || 0);
  const limit = Math.max(1, Number(params.limit) || 1);
  const page = Math.max(1, Number(params.page) || 1);

  if (total === 0 && !params.hasMore) return false;

  const isOnlyOnePage = page === 1 && total <= limit && !params.hasMore;
  return !isOnlyOnePage;
}

export function PaginatedListFooter({
  page,
  limit,
  total,
  hasMore,
  onPrevious,
  onNext,
  className,
  isLoading = false,
}: PaginatedListFooterProps) {
  
  // Consolidate all pagination math into one memoized object with safety checks
  const stats = useMemo(() => {
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeLimit = Math.max(1, Number(limit) || 1);
    const safePage = Math.max(1, Number(page) || 1);
    
    // Page count calculation logic refinement
    const pageCount = Math.max(1, Math.ceil(safeTotal / safeLimit));

    return {
      safePage,
      pageCount,
      canGoBack: safePage > 1 && !isLoading,
      canGoForward: hasMore && !isLoading,
    };
  }, [page, limit, total, hasMore, isLoading]);

  if (!shouldRenderPaginatedListFooter({ page, limit, total, hasMore }) && !isLoading) {
    return null;
  }

  return (
    <footer
      className={cn(
        "flex items-center justify-between border-t border-border/60 px-4 py-3 text-sm text-muted-foreground",
        className
      )}
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-1">
        <span aria-live="polite" className="tabular-nums">
          {isLoading ? (
            "Loading pages..."
          ) : (
            <>Page {stats.safePage} of {stats.pageCount}</>
          )}
        </span>
      </div>

      <div className="flex gap-2">
        <Button
          variant="none"
          effect="fade"
          size="sm"
          disabled={!stats.canGoBack}
          onClick={onPrevious}
          aria-label="Previous page"
          className="min-w-[80px]" // Button size consistency to prevent layout shift
        >
          Previous
        </Button>
        <Button 
          variant="none" 
          effect="fade" 
          size="sm" 
          disabled={!stats.canGoForward} 
          onClick={onNext}
          aria-label="Next page"
          className="min-w-[80px]"
        >
          Next
        </Button>
      </div>
    </footer>
  );
}

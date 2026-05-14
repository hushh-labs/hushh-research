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
}

/**
 * Deterministic helper to check if the footer provides any value to the user.
 */
export function shouldRenderPaginatedListFooter(params: {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}) {
  const total = Math.max(0, params.total || 0);
  const limit = Math.max(1, params.limit || 1);
  const page = Math.max(1, params.page || 1);

  if (total === 0) return false;

  // Don't render if we are on the first page, the total fits in one page, 
  // and the server says there's nothing else coming.
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
}: PaginatedListFooterProps) {

  // Consolidate all pagination math into one memoized object
  const stats = useMemo(() => {
    const safeTotal = Math.max(0, total || 0);
    const safeLimit = Math.max(1, limit || 1);
    const safePage = Math.max(1, page || 1);
    const pageCount = Math.ceil(safeTotal / safeLimit) || 1;

    return {
      safePage,
      pageCount,
      canGoBack: safePage > 1,
      canGoForward: hasMore && safePage < pageCount,
    };
  }, [page, limit, total, hasMore]);

  if (!shouldRenderPaginatedListFooter({ page, limit, total, hasMore })) {
    return null;
  }

  return (
    <footer
      className={cn(
        "flex items-center justify-between border-t border-border/60 px-4 py-3 text-sm text-muted-foreground",
        className
      )}
    >
      <span aria-live="polite">
        Page {stats.safePage} of {stats.pageCount}
      </span>
      <div className="flex gap-2">
        <Button
          variant="none"
          effect="fade"
          size="sm"
          disabled={!stats.canGoBack}
          onClick={onPrevious}
          aria-label="Go to previous page"
        >
          Previous
        </Button>
        <Button
          variant="none"
          effect="fade"
          size="sm"
          disabled={!hasMore}
          onClick={onNext}
          aria-label="Go to next page"
        >
          Next
        </Button>
      </div>
    </footer>
  );
}
"use client";

import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";

export function shouldRenderPaginatedListFooter(params: {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}) {
  const safePage = Math.max(1, params.page || 1);
  const safeLimit = Math.max(1, params.limit || 1);
  const safeTotal = Math.max(0, params.total || 0);

  if (safeTotal === 0) return false;
  if (safePage === 1 && safeTotal <= safeLimit && !params.hasMore) return false;
  return true;
}

export function PaginatedListFooter({
  page,
  limit,
  total,
  hasMore,
  onPrevious,
  onNext,
  className,
}: {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  onPrevious: () => void;
  onNext: () => void;
  className?: string;
}) {
  if (!shouldRenderPaginatedListFooter({ page, limit, total, hasMore })) {
    return null;
  }

  const safePage = Math.max(1, page || 1);
  const safeLimit = Math.max(1, limit || 1);
  const pageCount = Math.max(1, Math.ceil(Math.max(0, total || 0) / safeLimit));

  return (
    <div
      className={cn(
        "flex items-center justify-between border-t border-border/60 px-4 py-3 text-sm text-muted-foreground",
        className
      )}
    >
      <span>
        Page {safePage} of {pageCount}
      </span>
      <div className="flex gap-2">
        <Button
          variant="none"
          effect="fade"
          size="sm"
          disabled={safePage <= 1}
          onClick={onPrevious}
        >
          Previous
        </Button>
        <Button variant="none" effect="fade" size="sm" disabled={!hasMore} onClick={onNext}>
          Next
        </Button>
      </div>
    </div>
  );
}

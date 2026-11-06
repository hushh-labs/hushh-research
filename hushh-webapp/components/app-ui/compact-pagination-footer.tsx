"use client";

import { ChevronLeft, ChevronRight } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type CompactPaginationFooterProps = {
  total: number;
  page: number;
  pageSize: number;
  pageSizes: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  itemLabels?: readonly [singular: string, plural: string];
  className?: string;
};

export function CompactPaginationFooter({
  total, page, pageSize, pageSizes, onPageChange, onPageSizeChange, itemLabels, className,
}: CompactPaginationFooterProps) {
  if (total === 0) return null;
  const pages = Math.ceil(total / pageSize);
  const currentPage = Math.max(1, Math.min(page, pages));
  const first = (currentPage - 1) * pageSize + 1;
  const last = Math.min(currentPage * pageSize, total);
  const label = itemLabels?.[total === 1 ? 0 : 1];
  const showRowsControl = pageSizes.length > 1 && pageSizes.some(size => size < total);

  return (
    <footer className={cn("flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1", className)}
      data-slot="compact-pagination-footer" data-no-route-swipe>
      <p role="status" className="ui-text-row-description tabular-nums text-muted-foreground">
        {first}–{last} of {total}{label ? " " + label : ""}
      </p>
      <div className="ms-auto flex max-w-full flex-wrap items-center justify-end gap-x-2">
        {showRowsControl ? (
          <Select value={String(pageSize)} onValueChange={value => onPageSizeChange(Number(value))}>
            <SelectTrigger aria-label="Rows per page" className="ui-text-row-description min-h-11 gap-1 px-2 shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizes.map(size => <SelectItem key={size} value={String(size)}>{size} rows</SelectItem>)}
            </SelectContent>
          </Select>
        ) : null}
        {pages > 1 ? (
          <nav aria-label="Pagination" className="flex shrink-0 items-center">
            <Button type="button" variant="ghost" size="icon-touch" aria-label="Go to previous page"
              disabled={currentPage === 1} onClick={() => onPageChange(currentPage - 1)}>
              <ChevronLeft aria-hidden="true" className="size-4" />
            </Button>
            <Select value={String(currentPage)} onValueChange={value => onPageChange(Number(value))}>
              <SelectTrigger aria-label="Page" className="ui-text-row-description min-h-11 gap-1 px-2 tabular-nums shadow-none">
                <SelectValue>{currentPage} / {pages}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: pages }, (_, index) => (
                  <SelectItem key={index + 1} value={String(index + 1)}>Page {index + 1}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="ghost" size="icon-touch" aria-label="Go to next page"
              disabled={currentPage === pages} onClick={() => onPageChange(currentPage + 1)}>
              <ChevronRight aria-hidden="true" className="size-4" />
            </Button>
          </nav>
        ) : null}
      </div>
    </footer>
  );
}

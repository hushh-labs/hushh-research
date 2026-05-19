import { Skeleton } from "@/components/ui/skeleton"

import { cn } from "@/lib/utils"

interface DataTableSkeletonProps {
  columns?: number
  rows?: number
  showSearchBar?: boolean
  className?: string
}

export function DataTableSkeleton({
  columns = 4,
  rows = 8,
  showSearchBar = true,
  className,
}: DataTableSkeletonProps) {
  return (
    <div
      className={cn("space-y-[var(--data-table-controls-gap,12px)]", className)}
      aria-busy="true"
      aria-label="Loading table data"
    >
      {showSearchBar && (
        <div className="flex flex-col gap-3 sm:flex-row">
          <Skeleton className="h-9 flex-1" />
        </div>
      )}

      <div className="overflow-hidden rounded-lg border">
        <div className="flex gap-4 border-b px-[var(--data-table-cell-px,16px)] py-3">
          {Array.from({ length: columns }).map((_, i) => (
            <Skeleton
              key={i}
              className="h-3.5"
              style={{ flex: i === 0 ? 2 : 1 }}
            />
          ))}
        </div>

        {Array.from({ length: rows }).map((_, rowIdx) => (
          <div
            key={rowIdx}
            className="flex gap-4 border-b px-[var(--data-table-cell-px,16px)] py-[var(--data-table-cell-py,12px)] last:border-b-0"
            style={{ opacity: Math.max(0.3, 1 - rowIdx * 0.09) }}
          >
            {Array.from({ length: columns }).map((_, colIdx) => (
              <Skeleton
                key={colIdx}
                className="h-4"
                style={{ flex: colIdx === 0 ? 2 : 1 }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
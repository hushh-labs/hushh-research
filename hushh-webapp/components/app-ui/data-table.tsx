"use client";

/**
 * Reusable DataTable Component with Filtering and Pagination
 * Built on TanStack Table + shadcn/ui table component
 */

import * as React from "react";
import {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

const TABLE_SWIPE_THRESHOLD_PX = 44;

function buildPaginationItems(currentPage: number, pageCount: number): Array<number | "ellipsis"> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, "ellipsis", pageCount];
  }

  if (currentPage >= pageCount - 3) {
    return [1, "ellipsis", pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
  }

  return [1, "ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", pageCount];
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  searchKey?: string;
  globalSearchKeys?: string[];
  searchPlaceholder?: string;
  filterKey?: string;
  filterOptions?: { label: string; value: string }[];
  filterPlaceholder?: string;
  onRowClick?: (row: TData) => void;
  initialPageSize?: number;
  pageSizeOptions?: number[];
  rowClassName?: (row: TData) => string;
  enableSearch?: boolean;
  tableContainerClassName?: string;
  tableClassName?: string;
  density?: "default" | "compact";
  stickyHeader?: boolean;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  searchKey,
  globalSearchKeys,
  searchPlaceholder = "Search...",
  filterKey,
  filterOptions,
  filterPlaceholder = "Filter...",
  onRowClick,
  initialPageSize = 8,
  pageSizeOptions = [8, 16, 24],
  rowClassName,
  enableSearch = true,
  tableContainerClassName,
  tableClassName,
  density = "default",
  stickyHeader = false,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );
  const [globalFilter, setGlobalFilter] = React.useState("");
  const swipeStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const normalizedSearchKeys = React.useMemo(
    () =>
      Array.from(
        new Set(
          (globalSearchKeys && globalSearchKeys.length > 0
            ? globalSearchKeys
            : searchKey
              ? [searchKey]
              : []
          )
            .map((key) => key.trim())
            .filter((key) => key.length > 0)
        )
      ),
    [globalSearchKeys, searchKey]
  );
  const globalSearchFilterFn = React.useCallback(
    (row: { original: TData }, _columnId: string, filterValue: unknown) => {
      if (typeof filterValue !== "string") return true;
      const query = filterValue.trim().toLowerCase();
      if (!query) return true;

      const source = row.original as Record<string, unknown>;
      return normalizedSearchKeys.some((key) => {
        const value = source[key];
        if (value === null || value === undefined) return false;
        return String(value).toLowerCase().includes(query);
      });
    },
    [normalizedSearchKeys]
  );
  const normalizedPageSizeOptions = React.useMemo(
    () =>
      Array.from(new Set([initialPageSize, ...pageSizeOptions]))
        .filter((size) => Number.isFinite(size) && size > 0)
        .sort((a, b) => a - b),
    [initialPageSize, pageSizeOptions]
  );

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    ...(normalizedSearchKeys.length > 0
      ? {
          globalFilterFn: globalSearchFilterFn,
        }
      : {}),
    state: {
      sorting,
      columnFilters,
      globalFilter,
    },
    initialState: {
      pagination: {
        pageSize: initialPageSize,
      },
    },
  });

  React.useEffect(() => {
    table.setPageIndex(0);
  }, [globalFilter, columnFilters, table]);

  const filteredCount = table.getFilteredRowModel().rows.length;
  const pageIndex = table.getState().pagination.pageIndex;
  const pageSize = table.getState().pagination.pageSize;
  const rangeStart = filteredCount === 0 ? 0 : pageIndex * pageSize + 1;
  const rangeEnd = filteredCount === 0 ? 0 : Math.min((pageIndex + 1) * pageSize, filteredCount);
  const pageCount = table.getPageCount();
  const currentPage = pageCount === 0 ? 0 : pageIndex + 1;
  const hasMultiplePages = pageCount > 1;
  const paginationItems = React.useMemo(
    () => buildPaginationItems(currentPage, pageCount),
    [currentPage, pageCount]
  );

  const handleTouchStart = React.useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const handleTouchEnd = React.useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      if (!start || !hasMultiplePages) return;

      const touch = event.changedTouches[0];
      if (!touch) return;
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;

      if (Math.abs(deltaX) < TABLE_SWIPE_THRESHOLD_PX || Math.abs(deltaY) > Math.abs(deltaX)) {
        return;
      }

      if (deltaX < 0 && table.getCanNextPage()) {
        table.nextPage();
        return;
      }

      if (deltaX > 0 && table.getCanPreviousPage()) {
        table.previousPage();
      }
    },
    [hasMultiplePages, table]
  );

  const compact = density === "compact";
  return (
    <div
      className="space-y-[var(--data-table-controls-gap)]"
      data-no-route-swipe={hasMultiplePages ? "true" : undefined}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Search and Filter Controls */}
      {(enableSearch || (filterKey && filterOptions)) && (
        <div className="flex flex-col gap-3 sm:flex-row">
          {/* Global Search */}
          {enableSearch ? (
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={searchPlaceholder}
                value={globalFilter ?? ""}
                onChange={(e) => setGlobalFilter(e.target.value)}
                className="pl-9 cursor-text"
              />
            </div>
          ) : null}

          {/* Column Filter Dropdown */}
          {filterKey && filterOptions && (
            <Select
              value={
                (table.getColumn(filterKey)?.getFilterValue() as string) ?? "all"
              }
              onValueChange={(value) =>
                table
                  .getColumn(filterKey)
                  ?.setFilterValue(value === "all" ? undefined : value)
              }
            >
              <SelectTrigger className="w-full sm:w-[200px] cursor-pointer">
                <SelectValue placeholder={filterPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="cursor-pointer">
                  All
                </SelectItem>
                {filterOptions.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    className="cursor-pointer"
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {/* Table */}
      <div className={cn("overflow-x-auto overflow-y-hidden rounded border", tableContainerClassName)}>
        <Table className={tableClassName}>
          <TableHeader className={stickyHeader ? "sticky top-0 z-10 bg-[var(--app-card-surface-default)]/96 backdrop-blur supports-[backdrop-filter]:bg-[var(--app-card-surface-default)]/88" : undefined}>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn(
                      compact
                        ? "px-[max(10px,calc(var(--data-table-cell-px)-2px))] py-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground"
                        : "px-[var(--data-table-cell-px)] py-[calc(var(--data-table-cell-py)-1px)]",
                      header.column.getCanSort() ? "cursor-pointer" : ""
                    )}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                    {{
                      asc: " ↑",
                      desc: " ↓",
                    }[header.column.getIsSorted() as string] ?? null}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className={cn(
                    onRowClick
                      ? "cursor-pointer hover:bg-foreground/[0.045] active:bg-foreground/[0.065]"
                      : "hover:bg-foreground/[0.032]",
                    rowClassName?.(row.original)
                  )}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        compact
                          ? "px-[max(10px,calc(var(--data-table-cell-px)-2px))] py-2.5 align-top"
                          : "px-[var(--data-table-cell-px)] py-[var(--data-table-cell-py)]"
                      )}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 px-[var(--data-table-cell-px)] text-center"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {hasMultiplePages ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-muted-foreground sm:text-sm">
            Showing {rangeStart}-{rangeEnd} of {filteredCount}
          </div>

          <div className="flex flex-col items-stretch gap-2 sm:items-end">
            <div className="flex items-center justify-between gap-2 sm:justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 min-w-[64px] justify-between px-2 text-xs sm:min-w-[80px] sm:px-3 sm:text-sm"
                    data-no-route-swipe
                  >
                    {table.getState().pagination.pageSize}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {normalizedPageSizeOptions.map((size) => (
                    <DropdownMenuItem
                      key={size}
                      onSelect={() => table.setPageSize(size)}
                      className="cursor-pointer"
                    >
                      {size}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="text-xs text-muted-foreground sm:text-sm">
                Page {currentPage} of {pageCount}
              </span>
            </div>

            <Pagination className="justify-end">
              <PaginationContent data-no-route-swipe>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    aria-disabled={!table.getCanPreviousPage()}
                    className={cn(
                      !table.getCanPreviousPage() && "pointer-events-none opacity-50"
                    )}
                    onClick={(event) => {
                      event.preventDefault();
                      if (table.getCanPreviousPage()) {
                        table.previousPage();
                      }
                    }}
                  />
                </PaginationItem>
                {paginationItems.map((item, index) =>
                  item === "ellipsis" ? (
                    <PaginationItem key={`ellipsis-${index}`}>
                      <PaginationEllipsis />
                    </PaginationItem>
                  ) : (
                    <PaginationItem key={item}>
                      <PaginationLink
                        href="#"
                        isActive={item === currentPage}
                        onClick={(event) => {
                          event.preventDefault();
                          table.setPageIndex(item - 1);
                        }}
                      >
                        {item}
                      </PaginationLink>
                    </PaginationItem>
                  )
                )}
                <PaginationItem>
                  <PaginationNext
                    href="#"
                    aria-disabled={!table.getCanNextPage()}
                    className={cn(!table.getCanNextPage() && "pointer-events-none opacity-50")}
                    onClick={(event) => {
                      event.preventDefault();
                      if (table.getCanNextPage()) {
                        table.nextPage();
                      }
                    }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </div>
      ) : null}
    </div>
  );
}

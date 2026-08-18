"use client";

import * as React from "react";
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type Row,
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
  PaginationItem,
} from "@/components/ui/pagination";
import { Search } from "lucide-react";
import { surfaceDataTableShellClassName } from "@/lib/morphy-ux/surfaces";
import { cn } from "@/lib/utils";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  searchKey?: string;
  globalSearchKeys?: string[];
  searchPlaceholder?: string;
  filterKey?: string;
  filterOptions?: { label: string; value: string }[];
  filterPlaceholder?: string;
  onRowClick?: (
    row: TData,
    event: React.MouseEvent<HTMLTableRowElement> | React.KeyboardEvent<HTMLTableRowElement>,
  ) => void;
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
    [],
  );
  const [searchTerm, setSearchTerm] = React.useState("");
  const [globalFilter, setGlobalFilter] = React.useState("");

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setGlobalFilter(searchTerm);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

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
            .filter((key) => key.length > 0),
        ),
      ),
    [globalSearchKeys, searchKey],
  );

  const globalSearchFilterFn = React.useCallback(
    (row: Row<TData>, _columnId: string, filterValue: unknown) => {
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
    [normalizedSearchKeys],
  );

  const normalizedPageSizeOptions = React.useMemo(
    () =>
      Array.from(new Set([initialPageSize, ...pageSizeOptions]))
        .filter((size) => Number.isFinite(size) && size > 0)
        .sort((a, b) => a - b),
    [initialPageSize, pageSizeOptions],
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
      ? { globalFilterFn: globalSearchFilterFn }
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
  const rangeEnd =
    filteredCount === 0
      ? 0
      : Math.min((pageIndex + 1) * pageSize, filteredCount);
  const pageCount = table.getPageCount();
  const currentPage = pageCount === 0 ? 0 : pageIndex + 1;
  const hasMultiplePages = pageCount > 1;

  const compact = density === "compact";
  const resolvedTableShellClassName = cn("w-full", tableContainerClassName);

  return (
    <div
      className="space-y-[var(--data-table-controls-gap)]"
      data-no-route-swipe={hasMultiplePages ? "true" : undefined}
    >
      {(enableSearch || (filterKey && filterOptions)) && (
        <div className="flex flex-col gap-3 sm:flex-row">
          {enableSearch && (
            <div className="relative flex-1">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                placeholder={searchPlaceholder}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9 cursor-text"
                aria-label="Search table"
              />
            </div>
          )}

          {filterKey && filterOptions && (
            <Select
              value={
                (table.getColumn(filterKey)?.getFilterValue() as string) ??
                "all"
              }
              onValueChange={(value) =>
                table
                  .getColumn(filterKey)
                  ?.setFilterValue(value === "all" ? undefined : value)
              }
            >
              <SelectTrigger
                className="w-full sm:w-[200px] cursor-pointer"
                aria-label={filterPlaceholder}
              >
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

      <div
        className={cn(
          surfaceDataTableShellClassName,
          resolvedTableShellClassName,
        )}
        data-slot="surface-data-table-shell"
      >
        <Table className={tableClassName}>
          <TableHeader
            className={
              stickyHeader
                ? "sticky top-0 z-10 bg-[color:var(--app-card-surface-sticky-header-solid)] backdrop-blur"
                : undefined
            }
          >
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn(
                      compact
                        ? "px-[max(10px,calc(var(--data-table-cell-px)-2px))] py-2 text-[13px] font-normal tracking-normal text-muted-foreground"
                        : "px-[var(--data-table-cell-px)] py-[calc(var(--data-table-cell-py)-1px)]",
                      header.column.getCanSort()
                        ? "cursor-pointer select-none"
                        : "",
                    )}
                    onClick={header.column.getToggleSortingHandler()}
                    tabIndex={header.column.getCanSort() ? 0 : undefined}
                    role={header.column.getCanSort() ? "button" : undefined}
                    aria-sort={
                      header.column.getCanSort()
                        ? header.column.getIsSorted() === "asc"
                          ? "ascending"
                          : header.column.getIsSorted() === "desc"
                            ? "descending"
                            : "none"
                        : undefined
                    }
                    onKeyDown={(e) => {
                      if (
                        header.column.getCanSort() &&
                        (e.key === "Enter" || e.key === " ")
                      ) {
                        e.preventDefault();

                        header.column.toggleSorting(
                          header.column.getIsSorted() === "asc",
                        );
                      }
                    }}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
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
          <TableBody data-no-auto-fade="true">
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  aria-selected={row.getIsSelected() || undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? "button" : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick(row.original, e);
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    onRowClick
                      ? "cursor-pointer transition-[background-color] duration-200 ease-out hover:bg-foreground/[0.045] active:bg-foreground/[0.065]"
                      : "transition-[background-color] duration-200 ease-out hover:bg-foreground/[0.032]",
                    rowClassName?.(row.original),
                  )}
                  onClick={
                    onRowClick
                      ? (event) => {
                          const target = event.target as HTMLElement | null;
                          if (target?.closest("button, a, input, select, textarea, [role='menuitem']")) {
                            return;
                          }
                          onRowClick(row.original, event);
                        }
                      : undefined
                  }
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        compact
                          ? "px-[max(10px,calc(var(--data-table-cell-px)-2px))] py-2.5 align-middle"
                          : "px-[var(--data-table-cell-px)] py-[var(--data-table-cell-py)]",
                      )}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 px-[var(--data-table-cell-px)] text-center text-muted-foreground"
                >
                  No results found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {hasMultiplePages && (
        <div className="flex flex-col gap-2 pt-2 text-xs text-muted-foreground">
          {/* Row 1: Rows selector (left) + Range indicator (right) */}
          <div
            aria-live="polite"
            aria-atomic="true"
            className="flex w-full items-center justify-between gap-3"
            data-slot="data-table-range-controls"
          >
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Rows</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 min-w-[48px] justify-center text-center px-2 text-xs font-medium"
                    data-no-route-swipe
                    aria-label="Rows per page"
                  >
                    {table.getState().pagination.pageSize}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {normalizedPageSizeOptions.map((size) => (
                    <DropdownMenuItem
                      key={size}
                      onSelect={() => table.setPageSize(size)}
                      className="cursor-pointer text-xs"
                    >
                      {size}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              Showing {rangeStart}–{rangeEnd} of {filteredCount}
            </span>
          </div>

          {/* Row 2: Page X of Y (left) + Compact Pagination < [ 2 ] > (right) */}
          <div
            className="flex w-full items-center justify-between gap-3"
            data-slot="data-table-page-controls"
          >
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              Page {currentPage} of {pageCount}
            </span>
            <Pagination className="mx-0 w-auto justify-end">
              <PaginationContent
                data-no-route-swipe
                className="flex-nowrap items-center gap-1"
              >
                <PaginationItem>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!table.getCanPreviousPage()}
                    className={cn(
                      "h-7 w-7 p-0 text-xs text-muted-foreground hover:text-foreground",
                      !table.getCanPreviousPage() &&
                        "pointer-events-none opacity-40",
                    )}
                    onClick={(event) => {
                      event.preventDefault();
                      if (table.getCanPreviousPage()) {
                        table.previousPage();
                      }
                    }}
                    aria-label="Previous page"
                  >
                    ‹
                  </Button>
                </PaginationItem>
                <PaginationItem>
                  <span className="flex h-7 min-w-[28px] items-center justify-center rounded-md bg-secondary px-2 text-xs font-semibold text-secondary-foreground">
                    {currentPage}
                  </span>
                </PaginationItem>
                <PaginationItem>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!table.getCanNextPage()}
                    className={cn(
                      "h-7 w-7 p-0 text-xs text-muted-foreground hover:text-foreground",
                      !table.getCanNextPage() &&
                        "pointer-events-none opacity-40",
                    )}
                    onClick={(event) => {
                      event.preventDefault();
                      if (table.getCanNextPage()) {
                        table.nextPage();
                      }
                    }}
                    aria-label="Next page"
                  >
                    ›
                  </Button>
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </div>
      )}
    </div>
  );
}

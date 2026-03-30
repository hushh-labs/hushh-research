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
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
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
  onRowClick?: (row: TData) => void;
  initialPageSize?: number;
  pageSizeOptions?: number[];
  rowClassName?: (row: TData) => string;
  enableSearch?: boolean;
  tableContainerClassName?: string;
  tableClassName?: string;
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
  initialPageSize = 10,
  pageSizeOptions = [10, 25, 50],
  rowClassName,
  enableSearch = true,
  tableContainerClassName,
  tableClassName,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );
  const [globalFilter, setGlobalFilter] = React.useState("");
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

  return (
    <div className="space-y-4">
      {/* Search and Filter Controls */}
      {(enableSearch || (filterKey && filterOptions)) && (
        <div className="flex flex-col sm:flex-row gap-3">
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
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={
                      header.column.getCanSort() ? "cursor-pointer" : ""
                    }
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
                    onRowClick ? "cursor-pointer hover:bg-muted/50" : "hover:bg-muted/40",
                    rowClassName?.(row.original)
                  )}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
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
                  className="h-24 text-center"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination Controls */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs text-muted-foreground sm:text-sm">
          Showing {rangeStart}-{rangeEnd} of {filteredCount}
        </div>

        <div className="flex items-center justify-between gap-2 sm:justify-end">
          {/* Page Size Selector */}
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

          {/* Page Navigation */}
          <Button
            variant="outline"
            size="icon"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="cursor-pointer"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm">
            Page {currentPage} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="cursor-pointer"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

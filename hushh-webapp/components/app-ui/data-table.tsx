"use client";

import * as React from "react";
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { Search, SlidersHorizontal, Download, EyeOff } from "lucide-react";
import { surfaceDataTableShellClassName } from "@/lib/morphy-ux/surfaces";
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
  isLoading?: boolean; // New Feature: Explicit Async Loading State Toggle
  exportFileName?: string; // New Feature: Custom Export Document Filename
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
  isLoading = false,
  exportFileName = "data-grid-export",
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [searchTerm, setSearchTerm] = React.useState("");
  const [globalFilter, setGlobalFilter] = React.useState("");

  const swipeStartRef = React.useRef<{ x: number; y: number } | null>(null);

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
            .filter((key) => key.length > 0)
        )
      ),
    [globalSearchKeys, searchKey]
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
    onColumnVisibilityChange: setColumnVisibility,
    ...(normalizedSearchKeys.length > 0 ? { globalFilterFn: globalSearchFilterFn } : {}),
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility,
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

  /**
   * New Feature: Client CSV parsing export controller engine
   */
  const handleExportCSV = React.useCallback(() => {
    const visibleColumns = table.getVisibleFlatColumns().filter(col => typeof col.accessorFn === 'function' || typeof col.columnDef.header === 'string');
    const headers = visibleColumns.map(col => typeof col.columnDef.header === 'string' ? col.columnDef.header : col.id).join(",");
    
    const rows = table.getFilteredRowModel().rows.map(row => {
      return visibleColumns.map(col => {
        const value = col.accessorFn ? col.accessorFn(row.original, table.getRowModel().rows.indexOf(row)) : (row.original as any)[col.id];
        const cleanValue = value === null || value === undefined ? "" : String(value).replace(/"/g, '""');
        return `"${cleanValue}"`;
      }).join(",");
    });

    const csvContent = `data:text/csv;charset=utf-8,${[headers, ...rows].join("\n")}`;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${exportFileName}_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [table, exportFileName]);

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
  const resolvedTableShellClassName = cn("w-full overflow-x-auto", tableContainerClassName);

  return (
    <div
      className="space-y-[var(--data-table-controls-gap,1rem)]"
      data-no-route-swipe={hasMultiplePages ? "true" : undefined}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* GLOBAL ACTIONS AND DATA MANIPULATION TOOLBARS */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row flex-1 min-w-0">
          {enableSearch && (
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input
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
              value={(table.getColumn(filterKey)?.getFilterValue() as string) ?? "all"}
              onValueChange={(value) =>
                table.getColumn(filterKey)?.setFilterValue(value === "all" ? undefined : value)
              }
            >
              <SelectTrigger className="w-full sm:w-[200px] cursor-pointer" aria-label={filterPlaceholder}>
                <SelectValue placeholder={filterPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="cursor-pointer">All Options</SelectItem>
                {filterOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="cursor-pointer">
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* NEW FEATURES: CONTROLS SYSTEM DRAWER BUTTON PANELS */}
        <div className="flex items-center gap-2 self-end sm:self-auto">
          {data.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCSV}
              className="h-9 gap-2 text-xs font-medium cursor-pointer"
              title="Export Current View Set to CSV"
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Export CSV</span>
            </Button>
          )}

          {/* DYNAMIC COLUMN VISIBILITY PICKER HOOK */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-2 text-xs font-medium ml-auto cursor-pointer">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                <span>Columns</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[180px]">
              <DropdownMenuLabel className="text-xs">Toggle Visibility</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {table
                .getAllColumns()
                .filter((column) => column.getCanHide())
                .map((column) => {
                  return (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      className="capitalize text-xs cursor-pointer"
                      checked={column.getIsVisible()}
                      onCheckedChange={(value) => column.toggleVisibility(!!value)}
                    >
                      {typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id}
                    </DropdownMenuCheckboxItem>
                  );
                })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* CORE CANVAS ELEMENT FRAMEWORK */}
      <div className={cn(surfaceDataTableShellClassName, resolvedTableShellClassName)} data-slot="surface-data-table-shell">
        <Table className={tableClassName}>
          <TableHeader className={stickyHeader ? "sticky top-0 z-10 bg-background/95 backdrop-blur shadow-sm" : undefined}>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn(
                      compact
                        ? "px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground font-semibold"
                        : "px-4 py-3",
                      header.column.getCanSort() ? "cursor-pointer select-none hover:bg-muted/40 transition-colors" : ""
                    )}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <div className="flex items-center gap-1.5">
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      {{
                        asc: " ⬆️",
                        desc: " ⬇️",
                      }[header.column.getIsSorted() as string] ?? null}
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody data-no-auto-fade="true">
            {/* FEATURE: SHIMMER RUNTIME SKELETON REPLACEMENT */}
            {isLoading ? (
              Array.from({ length: pageSize }).map((_, rowIndex) => (
                <TableRow key={`shimmer-row-${rowIndex}`}>
                  {columns.map((_, colIndex) => (
                    <TableCell key={`shimmer-cell-${colIndex}`} className={compact ? "py-3 px-3" : "py-4 px-4"}>
                      <div className="h-4 w-full animate-pulse rounded bg-muted/60" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className={cn(
                    onRowClick
                      ? "cursor-pointer transition-[background-color,transform] duration-200 ease-out hover:-translate-y-px hover:bg-foreground/[0.045] active:translate-y-0 active:bg-foreground/[0.065]"
                      : "transition-[background-color] duration-200 ease-out hover:bg-foreground/[0.032]",
                    rowClassName?.(row.original)
                  )}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={compact ? "px-3 py-2.5 align-middle" : "px-4 py-3.5"}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={table.getAllColumns().length} className="h-32 text-center text-sm text-muted-foreground">
                  <div className="flex flex-col items-center justify-center gap-1.5 py-6">
                    <EyeOff className="h-5 w-5 text-muted-foreground/60" />
                    <p className="font-medium">No results found matching execution queries.</p>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* FOOTER PAGINATION HANDLERS CONTROL BLOCK */}
      {hasMultiplePages && !isLoading && (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pt-2">
          <div className="text-xs text-muted-foreground font-medium">
            Showing <span className="text-foreground font-semibold">{rangeStart}</span> to{" "}
            <span className="text-foreground font-semibold">{rangeEnd}</span> of{" "}
            <span className="text-foreground font-semibold">{filteredCount}</span> elements
          </div>

          <div className="flex flex-col items-stretch gap-2.5 sm:items-end">
            <div className="flex items-center justify-between gap-3 sm:justify-end">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Rows per page:</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 min-w-[64px] justify-between px-2 text-xs" data-no-route-swipe>
                      <span>{table.getState().pagination.pageSize}</span>
                      <span className="text-[10px] text-muted-foreground">▼</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[64px]">
                    {normalizedPageSizeOptions.map((size) => (
                      <DropdownMenuItem key={size} onSelect={() => table.setPageSize(size)} className="cursor-pointer text-xs justify-center font-medium">
                        {size}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <span className="text-xs text-muted-foreground font-medium border-l border-border/60 pl-3">
                Page {currentPage} of {pageCount}
              </span>
            </div>

            <Pagination className="justify-end">
              <PaginationContent data-no-route-swipe>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    aria-disabled={!table.getCanPreviousPage()}
                    className={cn(!table.getCanPreviousPage() && "pointer-events-none opacity-40")}
                    onClick={(event) => {
                      event.preventDefault();
                      if (table.getCanPreviousPage()) table.previousPage();
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
                    className={cn(!table.getCanNextPage() && "pointer-events-none opacity-40")}
                    onClick={(event) => {
                      event.preventDefault();
                      if (table.getCanNextPage()) table.nextPage();
                    }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </div>
      )}
    </div>
  );
}
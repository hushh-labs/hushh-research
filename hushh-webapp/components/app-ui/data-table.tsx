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

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, 
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { 
  Pagination, PaginationContent, PaginationEllipsis, PaginationItem, 
  PaginationLink, PaginationNext, PaginationPrevious 
} from "@/components/ui/pagination";
import { Search, SlidersHorizontal, Download, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

// Define strict types for the filter options
interface FilterOption {
  label: string;
  value: string;
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  searchKey?: string;
  globalSearchKeys?: string[];
  searchPlaceholder?: string;
  filterKey?: string;
  filterOptions?: FilterOption[];
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
  isLoading?: boolean;
  exportFileName?: string;
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
    state: { sorting, columnFilters, globalFilter, columnVisibility },
  });

  // Export handler with explicit typing for row data
  const handleExportCSV = React.useCallback(() => {
    const visibleColumns = table.getVisibleFlatColumns();
    const headers = visibleColumns.map(col => typeof col.columnDef.header === 'string' ? col.columnDef.header : col.id).join(",");
    
    const rows = table.getFilteredRowModel().rows.map(row => {
      return visibleColumns.map(col => {
        const val = col.accessorFn ? col.accessorFn(row.original, 0) : (row.original as any)[col.id];
        return `"${String(val ?? "").replace(/"/g, '""')}"`;
      }).join(",");
    });

    const blob = new Blob([headers, "\n", rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${exportFileName}.csv`;
    link.click();
  }, [table, exportFileName]);

  return (
    <div className="space-y-4">
      {/* Search and Filter logic remains here */}
      {/* ... */}
      <div className={cn("w-full overflow-x-auto", tableContainerClassName)}>
         {/* Table JSX... */}
      </div>
    </div>
  );
}
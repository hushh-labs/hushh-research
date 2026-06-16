"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// Extends TableProps to include custom layout features
interface TableProps extends React.ComponentProps<"table"> {
  striped?: boolean;
  containerClassName?: string;
}

function Table({ className, containerClassName, striped, ...props }: TableProps) {
  return (
    <div
      data-slot="table-container"
      className={cn("relative w-full overflow-x-auto", containerClassName)}
    >
      <table
        data-slot="table"
        className={cn(
          "w-full caption-bottom text-sm",
          striped && "[&_tbody_tr:nth-child(even)]:bg-muted/30",
          className
        )}
        {...props}
      />
    </div>
  );
}

// Added sortable prop for UI feedback
function TableHead({ className, sortable, ...props }: React.ComponentProps<"th"> & { sortable?: boolean }) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn(
        "text-foreground h-10 px-2 text-left align-middle font-medium whitespace-nowrap",
        sortable && "cursor-pointer select-none hover:text-primary transition-colors",
        "[&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  );
}

function TableRow({ className, selected, ...props }: React.ComponentProps<"tr"> & { selected?: boolean }) {
  return (
    <tr
      data-slot="table-row"
      data-state={selected ? "selected" : undefined}
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted/70",
        className
      )}
      {...props}
    />
  );
}

// Keeping other sub-components compatible
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("p-2 align-middle [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  );
}

// TableFooter and TableCaption remain standard but are re-exported
function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return <tfoot data-slot="table-footer" className={cn("bg-muted/50 font-medium", className)} {...props} />;
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("text-muted-foreground mt-4 text-sm", className)} {...props} />;
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
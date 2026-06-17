"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const Empty = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      data-slot="empty"
      className={cn(
        "flex min-h-[300px] flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-8 text-center animate-in fade-in duration-500",
        className
      )}
      {...props}
    />
  )
);
Empty.displayName = "Empty";

const EmptyHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="empty-header" className={cn("flex flex-col items-center gap-2", className)} {...props} />
);

const emptyMediaVariants = cva(
  "flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "bg-muted",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

const EmptyMedia = ({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) => (
  <div data-slot="empty-media" className={cn(emptyMediaVariants({ variant, className }))} {...props} />
);

const EmptyTitle = ({ className, ...props }: React.ComponentProps<"h3">) => (
  <h3 data-slot="empty-title" className={cn("text-lg font-semibold tracking-tight", className)} {...props} />
);

const EmptyDescription = ({ className, ...props }: React.ComponentProps<"p">) => (
  <p data-slot="empty-description" className={cn("text-sm text-muted-foreground max-w-sm", className)} {...props} />
);

const EmptyAction = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="empty-action" className={cn("mt-4 flex gap-2", className)} {...props} />
);

const EmptyContent = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    data-slot="empty-content"
    className={cn(
      "flex w-full max-w-sm min-w-0 flex-col items-center gap-3 sm:gap-4 text-sm text-balance",
      className
    )}
    {...props}
  />
);

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyAction, EmptyMedia };
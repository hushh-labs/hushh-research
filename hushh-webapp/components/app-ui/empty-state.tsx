import * as React from "react";
import { cn } from "@/lib/morphy-ux/cn";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}

/**
 * Accessible Empty State Component
 * Used when lists, tables, or search results return no data.
 * Maintains layout stability and implements aria-live polite to gently inform screen readers.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <section
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-[300px] w-full flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/10 px-6 py-12 text-center",
        "animate-in fade-in-50 duration-500",
        className
      )}
      {...props}
    >
      {icon && (
        <div
          className="mb-4 flex size-12 items-center justify-center rounded-full bg-muted/50 text-muted-foreground"
          aria-hidden="true"
        >
          {icon}
        </div>
      )}
      <h3 className="mb-2 text-lg font-semibold tracking-tight text-foreground">
        {title}
      </h3>
      <p className="mb-6 max-w-sm text-sm text-muted-foreground">
        {description}
      </p>
      {action && <div className="mt-2">{action}</div>}
    </section>
  );
}
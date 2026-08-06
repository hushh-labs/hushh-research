"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface MorphyTextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const MorphyTextarea = React.forwardRef<
  HTMLTextAreaElement,
  MorphyTextareaProps
>(({ className, error, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[100px] w-full rounded-2xl border bg-background/80 dark:bg-input/15 px-4 py-3.5 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/60 resize-none",
        "transition-all duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)]",
        error
          ? "border-destructive/80 focus-visible:border-destructive focus-visible:ring-destructive/20"
          : "border-input/70 focus-visible:border-primary/60 focus-visible:ring-primary/20",
        "focus-visible:outline-none focus-visible:ring-[3.5px] focus-visible:bg-background dark:focus-visible:bg-input/30",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

MorphyTextarea.displayName = "MorphyTextarea";

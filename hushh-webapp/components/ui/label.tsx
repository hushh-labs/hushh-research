"use client";

import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

interface LabelProps extends React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> {
  required?: boolean;
  variant?: "default" | "muted";
  error?: boolean;
}

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  LabelProps
>(({ className, required, variant = "default", error = false, children, ...props }, ref) => {
  return (
    <LabelPrimitive.Root
      ref={ref}
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none transition-colors",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        variant === "muted" ? "text-muted-foreground" : "text-foreground",
        error && "text-destructive",
        className
      )}
      {...props}
    >
      {children}
      {required && <span className="text-destructive">*</span>}
    </LabelPrimitive.Root>
  );
});

Label.displayName = "Label";

export { Label };
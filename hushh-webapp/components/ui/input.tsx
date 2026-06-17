"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// We keep InputProps simple to allow standard HTML attributes 
// while ensuring proper type inference.
interface InputProps extends React.ComponentProps<"input"> {
  error?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, error, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        data-slot="input"
        // Smart defaults for email/text to prevent annoying mobile keyboard behavior
        autoCapitalize={type === "email" ? "none" : props.autoCapitalize}
        autoCorrect={type === "email" ? "off" : props.autoCorrect}
        spellCheck={type === "email" ? false : props.spellCheck}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "read-only:bg-muted read-only:cursor-default",
          error && "border-destructive focus-visible:ring-destructive",
          className
        )}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";

export { Input };
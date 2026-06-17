"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface TextareaProps extends React.ComponentProps<"textarea"> {
  helperText?: string;
  showCounter?: boolean;
}

function Textarea({
  className,
  helperText,
  showCounter,
  maxLength,
  value,
  ...props
}: TextareaProps) {
  const [inputValue, setInputValue] = React.useState(value || "");

  // Sync state if props change externally
  React.useEffect(() => {
    if (value !== undefined) setInputValue(value as string);
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    props.onChange?.(e);
  };

  const charCount = String(inputValue).length;

  return (
    <div className="w-full space-y-1.5">
      <textarea
        data-slot="textarea"
        maxLength={maxLength}
        onChange={handleChange}
        value={inputValue}
        className={cn(
          "flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none",
          "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
          "field-sizing-content md:text-sm",
          className
        )}
        {...props}
      />

      {(helperText || showCounter) && (
        <div className="flex justify-between gap-2 px-1">
          <p className="text-[12px] text-muted-foreground">{helperText}</p>
          {showCounter && maxLength && (
            <p className={cn(
              "text-[12px] font-medium",
              charCount >= maxLength ? "text-destructive" : "text-muted-foreground"
            )}>
              {charCount} / {maxLength}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export { Textarea };
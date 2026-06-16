"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

export interface SecureValueMaskProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  unmaskedLength?: number;
  maskChar?: string;
  label?: string;
}

/**
 * Accessible Secure Value Mask
 * Protects sensitive data (Vault Keys, Phone Numbers, SSNs) from shoulder surfing.
 * Provides a standardized inline UI with a focusable hide/reveal toggle.
 */
export function SecureValueMask({
  value,
  unmaskedLength = 4,
  maskChar = "•",
  label = "Secure value",
  className,
  ...props
}: SecureValueMaskProps) {
  const [isRevealed, setIsRevealed] = React.useState(false);

  // Safely calculate the masked string without mutating the original value
  const displayValue = React.useMemo(() => {
    if (isRevealed || value.length <= unmaskedLength) return value;
    const maskedPart = maskChar.repeat(value.length - unmaskedLength);
    const visiblePart = value.slice(-unmaskedLength);
    return `${maskedPart}${visiblePart}`;
  }, [value, unmaskedLength, maskChar, isRevealed]);

  return (
    <div 
      className={cn(
        "inline-flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 pl-3 pr-1.5 py-1.5", 
        className
      )} 
      {...props}
    >
      <span 
        className="font-mono text-sm tracking-widest text-foreground transition-all duration-200" 
        aria-label={isRevealed ? label : `${label}, masked`}
      >
        {displayValue}
      </span>
      
      <button
        type="button"
        onClick={() => setIsRevealed(!isRevealed)}
        aria-pressed={isRevealed}
        aria-label={isRevealed ? "Hide value" : "Reveal value"}
        title={isRevealed ? "Hide value" : "Reveal value"}
        className={cn(
          "ml-2 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        )}
      >
        {isRevealed ? (
          <EyeOff className="size-3.5 animate-in zoom-in-75 duration-200" aria-hidden="true" />
        ) : (
          <Eye className="size-3.5 animate-in zoom-in-75 duration-200" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
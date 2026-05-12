"use client";

import * as React from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

export interface ClipboardCopyProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
  label?: string;
}

/**
 * Accessible Clipboard Copy Button
 * Provides an inline micro-interaction for copying text (IDs, Keys, Links).
 * Features smooth icon transitions and ARIA live regions for screen readers.
 */
export function ClipboardCopy({
  value,
  label = "Copy to clipboard",
  className,
  ...props
}: ClipboardCopyProps) {
  const [hasCopied, setHasCopied] = React.useState(false);

  const copyToClipboard = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setHasCopied(true);
      setTimeout(() => setHasCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy", err);
    }
  }, [value]);

  return (
    <button
      type="button"
      onClick={copyToClipboard}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md",
        "text-muted-foreground hover:bg-muted hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        "transition-colors duration-200",
        className
      )}
      title={label}
      aria-label={label}
      {...props}
    >
      {/* A11y: Hidden live region announces 'Copied' to screen readers */}
      <span className="sr-only" aria-live="polite">
        {hasCopied ? "Copied to clipboard" : ""}
      </span>
      {hasCopied ? (
        <Check className="size-3.5 text-emerald-500 animate-in zoom-in duration-200" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5 animate-in zoom-in duration-200" aria-hidden="true" />
      )}
    </button>
  );
}
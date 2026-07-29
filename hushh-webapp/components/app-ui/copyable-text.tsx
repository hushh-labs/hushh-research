"use client";

import React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopy } from "@/lib/hooks/use-copy";
import { Button } from "@/components/ui/button";

export interface CopyableTextProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The actual text content to be copied to the clipboard */
  textToCopy: string;
  /** Optional display text if you want to show something other than the raw text */
  displayText?: string;
  /** Whether to truncate the text with an ellipsis. Defaults to false. */
  truncate?: boolean;
  /** Size variant for the copy button. Defaults to 'icon-xs' */
  buttonSize?: "icon-xs" | "icon" | "sm";
  /** Optional class name for the text container */
  textClassName?: string;
}

/**
 * A reusable component that renders text alongside a copy-to-clipboard button.
 * Ideal for IDs, API keys, and code snippets.
 */
export function CopyableText({
  textToCopy,
  displayText,
  truncate = false,
  buttonSize = "icon-xs",
  textClassName,
  className,
  ...props
}: CopyableTextProps) {
  const { isCopied, copy } = useCopy();

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void copy(textToCopy);
  };

  return (
    <div
      className={cn("group flex items-center gap-1.5", className)}
      {...props}
    >
      <span
        className={cn(
          "text-sm text-foreground/80 font-mono",
          truncate && "truncate",
          textClassName
        )}
        title={truncate ? displayText || textToCopy : undefined}
      >
        {displayText || textToCopy}
      </span>
      <Button
        type="button"
        variant="ghost"
        size={buttonSize}
        onClick={handleCopy}
        className={cn(
          "shrink-0 text-muted-foreground opacity-50 transition-opacity hover:opacity-100 hover:text-foreground hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100",
          isCopied && "text-green-600 dark:text-green-500 opacity-100 hover:text-green-600 hover:bg-transparent"
        )}
        aria-label={`Copy ${displayText || textToCopy} to clipboard`}
      >
        {isCopied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

"use client";

import React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopy } from "@/lib/hooks/use-copy";
import { Button } from "@/components/ui/button";

interface CopyableTextProps {
  /** The text that will be copied to clipboard */
  textToCopy: string;
  /** The content to display (often the same as textToCopy) */
  children: React.ReactNode;
  /** Optional success toast message */
  successMessage?: string;
  /** Optional class names for the wrapper */
  className?: string;
  /** Whether to show the copy icon inline or absolute */
  layout?: "inline" | "absolute";
}

export function CopyableText({
  textToCopy,
  children,
  successMessage = "Copied to clipboard",
  className,
  layout = "absolute"
}: CopyableTextProps) {
  const { isCopied, copyToClipboard } = useCopy();

  return (
    <div className={cn("group relative inline-flex items-center gap-2", className)}>
      <div className="w-full truncate">{children}</div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => copyToClipboard(textToCopy, successMessage)}
        className={cn(
          "h-6 w-6 rounded-md transition-all",
          layout === "absolute" ? "absolute -right-8 opacity-0 group-hover:opacity-100" : "opacity-50 hover:opacity-100",
          isCopied ? "text-green-500 opacity-100" : "text-muted-foreground"
        )}
        title="Copy to clipboard"
        aria-label="Copy to clipboard"
      >
        {isCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

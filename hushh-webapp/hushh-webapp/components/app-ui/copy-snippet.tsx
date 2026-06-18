"use client";

import * as React from "react";
import { Copy, Check, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

export interface CopySnippetProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  label?: string;
  isSecret?: boolean;
  timeoutMs?: number;
}

/**
 * Accessible Secure Copy Snippet
 * Safely displays and copies sensitive strings (API Keys, Vault IDs).
 * Features optional obfuscation, temporary success states, and strict ARIA announcements.
 */
export function CopySnippet({
  value,
  label = "Copy to clipboard",
  isSecret = false,
  timeoutMs = 2000,
  className,
  ...props
}: CopySnippetProps) {
  const [hasCopied, setHasCopied] = React.useState(false);
  const [isRevealed, setIsRevealed] = React.useState(!isSecret);
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const onCopy = React.useCallback(async () => {
    if (!navigator?.clipboard) return;

    try {
      await navigator.clipboard.writeText(value);
      setHasCopied(true);

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setHasCopied(false);
      }, timeoutMs);
    } catch (err) {
      console.error("Failed to copy text to clipboard", err);
    }
  }, [value, timeoutMs]);

  // If secret, show only the last 4 characters, or dots if too short
  const displayValue = React.useMemo(() => {
    if (isRevealed) return value;
    if (value.length <= 4) return "••••";
    return `••••••••••••${value.slice(-4)}`;
  }, [value, isRevealed]);

  return (
    <div 
      className={cn(
        "group flex items-center justify-between gap-3 rounded-md border border-input bg-muted/30 py-1.5 pl-3 pr-1.5 transition-colors hover:border-border/80",
        className
      )}
      {...props}
    >
      <div className="flex flex-col overflow-hidden">
        {/* A11y: Contextual label for screen readers to know what they are copying */}
        {label && <span className="sr-only">{label}</span>}
        <code className="truncate font-mono text-sm tracking-tight text-foreground/80">
          {displayValue}
        </code>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {isSecret && (
          <button
            type="button"
            onClick={() => setIsRevealed(!isRevealed)}
            aria-label={isRevealed ? "Hide secret value" : "Reveal secret value"}
            className="flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isRevealed ? <EyeOff className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
          </button>
        )}

        <button
          type="button"
          onClick={onCopy}
          disabled={hasCopied}
          aria-label={hasCopied ? "Copied!" : label}
          className={cn(
            "flex size-7 items-center justify-center rounded-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            hasCopied 
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" 
              : "bg-background text-muted-foreground hover:text-foreground hover:shadow-sm border border-input/50"
          )}
        >
          {hasCopied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
        </button>
      </div>

      {/* A11y: Polite live region strictly for confirming the copy action to screen readers */}
      <span className="sr-only" aria-live="polite">
        {hasCopied ? `Successfully copied ${label} to clipboard.` : ""}
      </span>
    </div>
  );
}
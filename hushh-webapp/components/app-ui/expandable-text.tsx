"use client";

import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/morphy-ux/cn";

export interface ExpandableTextProps extends React.HTMLAttributes<HTMLDivElement> {
  text: string;
  maxLength?: number;
}

/**
 * Accessible Expandable Text (Read More)
 * Prevents long strings (logs, notes, descriptions) from breaking card or table layouts.
 * Features strict ARIA expanded states for screen readers and keyboard focus rings.
 */
export function ExpandableText({
  text,
  maxLength = 150,
  className,
  ...props
}: ExpandableTextProps) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  
  // A11y & Logic: Only show the toggle if the text actually exceeds the max length
  const isLongText = text.length > maxLength;

  // Safely truncate at the nearest word boundary if possible to avoid cutting words in half
  const displayString = React.useMemo(() => {
    if (isExpanded || !isLongText) return text;
    const truncated = text.slice(0, maxLength);
    const lastSpace = truncated.lastIndexOf(" ");
    const safeCutoff = lastSpace > 0 ? lastSpace : maxLength;
    return `${text.slice(0, safeCutoff).trim()}...`;
  }, [text, maxLength, isExpanded, isLongText]);

  return (
    <div className={cn("space-y-1.5", className)} {...props}>
      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap break-words">
        {displayString}
      </p>
      
      {isLongText && (
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          className={cn(
            "inline-flex items-center gap-1 mt-1 text-xs font-medium text-primary transition-colors",
            "hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          )}
        >
          {isExpanded ? (
            <>
              Show less <ChevronUp className="size-3" aria-hidden="true" />
            </>
          ) : (
            <>
              Read more <ChevronDown className="size-3" aria-hidden="true" />
            </>
          )}
        </button>
      )}
    </div>
  );
}
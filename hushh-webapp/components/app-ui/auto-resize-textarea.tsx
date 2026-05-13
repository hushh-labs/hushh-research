"use client";

import * as React from "react";
import { cn } from "@/lib/morphy-ux/cn";

export interface AutoResizeTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  maxHeight?: number;
  minHeight?: number;
  onEnterPress?: () => void;
}

/**
 * Auto-Resizing Textarea (Ideal for AI Chat / Kai)
 * Dynamically adjusts its height based on the scrollHeight of the content.
 * Supports Shift+Enter for new lines and captures isolated Enter presses for submission.
 */
export const AutoResizeTextarea = React.forwardRef<HTMLTextAreaElement, AutoResizeTextareaProps>(
  ({ className, maxHeight = 200, minHeight = 40, onEnterPress, onChange, onKeyDown, ...props }, ref) => {
    const internalRef = React.useRef<HTMLTextAreaElement>(null);
    
    // Merge the internal ref with the forwarded ref so the parent can still control it
    React.useImperativeHandle(ref, () => internalRef.current as HTMLTextAreaElement);

    const resize = React.useCallback(() => {
      const textarea = internalRef.current;
      if (!textarea) return;

      // Reset height to accurately calculate the new scrollHeight
      textarea.style.height = `${minHeight}px`;
      const scrollHeight = textarea.scrollHeight;

      if (scrollHeight > maxHeight) {
        textarea.style.height = `${maxHeight}px`;
        textarea.style.overflowY = "auto";
      } else {
        textarea.style.height = `${Math.max(scrollHeight, minHeight)}px`;
        textarea.style.overflowY = "hidden";
      }
    }, [maxHeight, minHeight]);

    // Resize on mount and when the external value changes programmatically
    React.useEffect(() => {
      resize();
    }, [resize, props.value]);

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      resize();
      if (onChange) onChange(e);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Chat UX: Pressing Enter without Shift should trigger the submit action
      if (e.key === "Enter" && !e.shiftKey && onEnterPress) {
        e.preventDefault();
        onEnterPress();
      }
      if (onKeyDown) onKeyDown(e);
    };

    return (
      <textarea
        ref={internalRef}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={1}
        className={cn(
          "flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          "transition-[height] duration-100 ease-in-out",
          className
        )}
        style={{ minHeight: `${minHeight}px` }}
        {...props}
      />
    );
  }
);

AutoResizeTextarea.displayName = "AutoResizeTextarea";
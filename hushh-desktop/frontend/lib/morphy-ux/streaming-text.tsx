/**
 * StreamingTextDisplay Component
 *
 * A container for displaying streaming text with auto-scroll and cursor.
 * Designed for ChatGPT/Perplexity-style streaming responses.
 *
 * Features:
 * - Auto-scroll as content grows (respects user scroll intent)
 * - Blinking cursor at end of text
 * - Smooth scroll behavior
 * - Markdown-safe whitespace handling
 * - Optional JSON-to-human-readable formatting
 *
 * @example
 * <StreamingTextDisplay
 *   text={streamedText}
 *   isStreaming={true}
 *   className="h-[300px]"
 * />
 *
 * @example
 * // With human-readable formatting for JSON streams
 * <StreamingTextDisplay
 *   text={jsonStream}
 *   isStreaming={true}
 *   formatAsHuman={true}
 *   className="h-[300px]"
 * />
 */

"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { cn } from "./cn";
import { StreamingCursor } from "./streaming-cursor";
import {
  createParserContext,
  formatJsonChunk,
  tryFormatComplete,
  type ParserContext,
} from "@/lib/utils/json-to-human";

export interface StreamingTextDisplayProps {
  /** The text to display */
  text: string;
  /** Whether streaming is active */
  isStreaming: boolean;
  /** Show blinking cursor */
  showCursor?: boolean;
  /** Cursor color variant */
  cursorColor?: "primary" | "muted" | "accent" | "success" | "error";
  /** Additional CSS classes for container */
  className?: string;
  /** Additional CSS classes for text */
  textClassName?: string;
  /** Threshold from bottom to consider "at bottom" (px) */
  scrollThreshold?: number;
  /** Enable smooth scroll */
  smoothScroll?: boolean;
  /** Placeholder text when empty */
  placeholder?: string;
  /** Transform JSON to human-readable format */
  formatAsHuman?: boolean;
  /** Callback when formatting is complete with parsed data */
  onFormatComplete?: (formattedText: string) => void;
}

export function StreamingTextDisplay({
  text,
  isStreaming,
  showCursor = true,
  cursorColor = "primary",
  className,
  textClassName,
  scrollThreshold = 100,
  smoothScroll = true,
  placeholder = "Waiting for response...",
  formatAsHuman = false,
  onFormatComplete,
}: StreamingTextDisplayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const hasUserScrolledRef = useRef(false);
  const parserContextRef = useRef<ParserContext>(createParserContext());
  const lastTextLengthRef = useRef(0);
  const lastScrollHeightRef = useRef(0);

  // Formatted text from JSON (updated in effect to avoid reading refs during render)
  const [formattedText, setFormattedText] = useState("");
  const displayText = formatAsHuman ? formattedText : text;

  // Reset parser context and scroll state when text is cleared
  useEffect(() => {
    if (!text || text.length === 0) {
      parserContextRef.current = createParserContext();
      lastTextLengthRef.current = 0;
      setFormattedText("");
      setUserScrolledUp(false);
      hasUserScrolledRef.current = false;
      lastScrollHeightRef.current = 0;
    }
  }, [text]);

  // Compute formatted text in effect (refs are safe here)
  useEffect(() => {
    if (!formatAsHuman) {
      setFormattedText(text);
      return;
    }
    if (!text) {
      setFormattedText("");
      return;
    }
    const newContent = text.slice(lastTextLengthRef.current);
    if (newContent) {
      const result = formatJsonChunk(newContent, parserContextRef.current);
      lastTextLengthRef.current = text.length;
      if (!isStreaming) {
        const completeFormatted = tryFormatComplete(parserContextRef.current);
        if (completeFormatted) {
          onFormatComplete?.(completeFormatted);
          setFormattedText(completeFormatted);
          return;
        }
      }
      setFormattedText(result.text);
      return;
    }
    if (!isStreaming) {
      const completeFormatted = tryFormatComplete(parserContextRef.current);
      if (completeFormatted) {
        onFormatComplete?.(completeFormatted);
        setFormattedText(completeFormatted);
        return;
      }
    }
    setFormattedText(parserContextRef.current.lastOutput || text);
  }, [text, isStreaming, formatAsHuman, onFormatComplete]);

  // Check if scrolled to bottom
  const checkIfAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;

    const { scrollTop, scrollHeight, clientHeight } = container;
    // Use a more generous threshold for "at bottom" detection
    return scrollHeight - scrollTop - clientHeight < scrollThreshold;
  }, [scrollThreshold]);

  // Handle user scroll - only track actual user interactions
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const atBottom = checkIfAtBottom();
    const currentScrollHeight = container.scrollHeight;
    
    // Detect if this is a user scroll vs programmatic scroll
    // If scrollHeight changed, it's likely content was added and we auto-scrolled
    const isContentGrowth = currentScrollHeight !== lastScrollHeightRef.current;
    lastScrollHeightRef.current = currentScrollHeight;
    
    // Only consider it a user scroll if content didn't just grow
    if (!isContentGrowth) {
      hasUserScrolledRef.current = true;
      
      // If user scrolled up (away from bottom), stop auto-scrolling
      if (!atBottom) {
        setUserScrolledUp(true);
      }
    }
    
    // If user scrolled back to bottom, resume auto-scrolling
    if (atBottom && userScrolledUp && hasUserScrolledRef.current) {
      setUserScrolledUp(false);
    }
  }, [checkIfAtBottom, userScrolledUp]);

  // Auto-scroll when text changes (if user hasn't scrolled up)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    // Don't auto-scroll if user has scrolled up
    if (userScrolledUp) return;

    // Use requestAnimationFrame to ensure DOM has updated
    requestAnimationFrame(() => {
      // Double-check container still exists
      if (!containerRef.current) return;
      
      // Update scroll height tracking before scrolling
      lastScrollHeightRef.current = containerRef.current.scrollHeight;
      
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: smoothScroll ? "smooth" : "auto",
      });
    });
  }, [displayText, smoothScroll, userScrolledUp]);

  // Attach scroll listener
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // Scroll to bottom on mount
  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      // Immediate scroll to bottom on mount
      container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
      lastScrollHeightRef.current = container.scrollHeight;
    }
  }, []); // Empty deps = run once on mount

  // Initial scroll to bottom when streaming starts
  useEffect(() => {
    if (isStreaming && !userScrolledUp) {
      const container = containerRef.current;
      if (container) {
        requestAnimationFrame(() => {
          if (containerRef.current) {
            lastScrollHeightRef.current = containerRef.current.scrollHeight;
            containerRef.current.scrollTo({
              top: containerRef.current.scrollHeight,
              behavior: "auto", // Instant scroll on initial
            });
          }
        });
      }
    }
  }, [isStreaming, userScrolledUp]);

  // Scroll to bottom when displayText first has content
  const hasDisplayText = displayText.length > 0;
  useEffect(() => {
    if (hasDisplayText && !userScrolledUp) {
      const container = containerRef.current;
      if (container) {
        requestAnimationFrame(() => {
          if (containerRef.current) {
            lastScrollHeightRef.current = containerRef.current.scrollHeight;
            containerRef.current.scrollTo({
              top: containerRef.current.scrollHeight,
              behavior: "auto",
            });
          }
        });
      }
    }
  }, [hasDisplayText, userScrolledUp]);

  const isEmpty = !displayText || displayText.length === 0;

  // Handle scroll to bottom button click
  const handleScrollToBottom = useCallback(() => {
    setUserScrolledUp(false);
    const container = containerRef.current;
    if (container) {
      lastScrollHeightRef.current = container.scrollHeight;
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "smooth",
      });
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn(
        "overflow-y-auto overscroll-contain",
        "scrollbar-thin scrollbar-thumb-muted scrollbar-track-transparent",
        className
      )}
    >
      {isEmpty && !isStreaming ? (
        <p className="text-muted-foreground text-sm italic">{placeholder}</p>
      ) : (
        <p
          className={cn(
            "whitespace-pre-wrap leading-relaxed text-sm",
            textClassName
          )}
        >
          {displayText}
          {showCursor && (isStreaming || isEmpty) && (
            <StreamingCursor isStreaming={isStreaming} color={cursorColor} />
          )}
        </p>
      )}

      {/* Scroll to bottom button (shows when user scrolled up during streaming) */}
      {userScrolledUp && isStreaming && (
        <button
          onClick={handleScrollToBottom}
          className={cn(
            "sticky bottom-2 left-1/2 -translate-x-1/2 z-10",
            "px-4 py-2 rounded-full",
            "bg-primary text-primary-foreground text-xs font-medium",
            "shadow-lg hover:shadow-xl transition-all",
            "animate-in fade-in slide-in-from-bottom-2",
            "flex items-center gap-1.5"
          )}
        >
          <svg
            className="w-3 h-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 14l-7 7m0 0l-7-7m7 7V3"
            />
          </svg>
          Scroll to bottom
        </button>
      )}
    </div>
  );
}

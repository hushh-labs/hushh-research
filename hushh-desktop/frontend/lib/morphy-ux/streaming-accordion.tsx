/**
 * StreamingAccordion Component
 *
 * A specialized accordion for displaying streaming AI responses.
 * Combines shadcn Accordion with streaming text capabilities.
 *
 * Features:
 * - Auto-expands when streaming starts
 * - Auto-collapses when streaming completes
 * - Auto-scrolls to bottom during streaming (start position is bottom)
 * - Shows streaming cursor during active streaming
 * - User can manually toggle at any time
 * - Smooth transitions between states
 *
 * @example
 * <StreamingAccordion
 *   id="ai-reasoning"
 *   title="AI Reasoning"
 *   text={streamingText}
 *   isStreaming={isStreaming}
 *   isComplete={isComplete}
 * />
 */

"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDownIcon, Sparkles, Loader2, Database, CheckCircle2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "./cn";
import { StreamingCursor } from "./streaming-cursor";
import { Icon } from "@/lib/morphy-ux/ui/icon";
import {
  createParserContext,
  formatJsonChunk,
  tryFormatComplete,
  type ParserContext,
} from "@/lib/utils/json-to-human";

// ============================================================================
// Helper: Format Thinking Stream
// ============================================================================

/**
 * Parses [N] **Header** and renders as bold/headers
 */
function formatThinkingText(text: string) {
  if (!text) return null;

  // Split by line
  const lines = text.split("\n");
  
  return lines.map((line, i) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) return <div key={i} className="h-2" />;

    // Match pattern: [number] **Header text**
    const headerMatch = trimmedLine.match(/^\[(\d+)\]\s+\*\*(.+?)\*\*$/);
    if (headerMatch) {
      const [, number, title] = headerMatch;
      return (
        <div key={i} className="mt-4 mb-2 first:mt-0">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-primary/10 text-primary text-[10px] font-bold mr-2 align-middle">
            {number}
          </span>
          <span className="text-sm font-bold text-foreground align-middle">
            {title}
          </span>
        </div>
      );
    }

    // Match pattern: **Header text** (with or without trailing content)
    // Be more aggressive in stripping stars from the start and end
    const boldHeaderMatch = trimmedLine.match(/^\*\*(.+?)\*\*$/) || trimmedLine.match(/^\*\*(.+)$/);
    if (boldHeaderMatch && boldHeaderMatch[1]) {
      const title = boldHeaderMatch[1].replace(/\*\*$/, "").trim();
      return (
        <div key={i} className="mt-4 mb-2 first:mt-0">
          <span className="text-sm font-bold text-foreground align-middle">
            {title}
          </span>
        </div>
      );
    }

    // Match bullet points: - Item or * Item
    const bulletMatch = trimmedLine.match(/^[-*]\s+(.+)$/);
    if (bulletMatch && bulletMatch[1]) {
      // Also strip inner bold if user doesn't want to see them
      const content = bulletMatch[1].replace(/\*\*/g, "");
      return (
        <div key={i} className="flex gap-2 mb-1 pl-2">
          <span className="text-primary mt-1">•</span>
          <span className="text-sm">{content}</span>
        </div>
      );
    }
    
    // Regular line - remove ALL instances of ** as requested
    const cleanLine = trimmedLine.replace(/\*\*/g, "");

    return (
      <div key={i} className="mb-1 last:mb-0">
        {cleanLine}
      </div>
    );
  });
}



// ============================================================================
// Types
// ============================================================================

export interface StreamingAccordionProps {
  /** Unique identifier for the accordion item */
  id: string;
  /** Title shown in the accordion header */
  title: string;
  /** The streaming text content */
  text: string;
  /** Whether streaming is active */
  isStreaming: boolean;
  /** Whether streaming has completed (triggers collapse) */
  isComplete?: boolean;
  /** Transform JSON to human-readable format */
  formatAsHuman?: boolean;
  /** Additional class for the container */
  className?: string;
  /** Max height when expanded (default: 300px) */
  maxHeight?: string;
  /** Callback when user manually toggles */
  onToggle?: (isOpen: boolean) => void;
  /** Icon to show in header (default: spinner) - can be string or React component */
  icon?: "brain" | "sparkles" | "spinner" | "database" | "none" | "check" | React.ReactNode;
  /** Custom class for the icon */
  iconClassName?: string;


  /** Show streaming cursor */
  showCursor?: boolean;
  /** Start expanded by default */
  defaultExpanded?: boolean;
  /** Auto-collapse after completion */
  autoCollapseOnComplete?: boolean;
  /** Optional className for the body text wrapper */
  bodyClassName?: string;
  /** Message shown while streaming if no text has arrived yet */
  emptyStreamingMessage?: string;
}

// ============================================================================
// Component
// ============================================================================

export function StreamingAccordion({
  id,
  title,
  text,
  isStreaming,
  isComplete = false,
  formatAsHuman = false,
  className,
  maxHeight = "300px",
  onToggle,
  icon = "spinner",
  iconClassName,
  showCursor = true,
  defaultExpanded = false,
  autoCollapseOnComplete = true,
  bodyClassName,
  emptyStreamingMessage = "Preparing stream...",
}: StreamingAccordionProps) {

  // Accordion open state
  const [isOpen, setIsOpen] = useState(defaultExpanded);
  const wasStreamingRef = useRef(false);
  const autoCollapseTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Scroll refs
  const contentRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const lastScrollHeightRef = useRef(0);

  // Text formatting
  const parserContextRef = useRef<ParserContext>(createParserContext());
  const lastTextLengthRef = useRef(0);
  const [formattedText, setFormattedText] = useState("");
  const displayText = formatAsHuman ? formattedText : text;

  // ============================================================================
  // Auto-expand when streaming starts
  // ============================================================================
  useEffect(() => {
    if (isStreaming && !wasStreamingRef.current) {
      // Streaming just started - expand
      setIsOpen(true);
      wasStreamingRef.current = true;
      setUserScrolledUp(false);
    }
  }, [isStreaming]);

  // ============================================================================
  // Auto-collapse when streaming completes
  // ============================================================================
  useEffect(() => {
    if (!autoCollapseOnComplete) {
      return;
    }
    // If it's complete, we collapse regardless of whether we saw the start
    // this ensures that if a component mounts with "isComplete: true", it stays closed.
    if (isComplete) {
      // Clear any existing timeout
      if (autoCollapseTimeoutRef.current) {
        clearTimeout(autoCollapseTimeoutRef.current);
      }
      // Delay collapse slightly for smooth UX
      autoCollapseTimeoutRef.current = setTimeout(() => {
        setIsOpen(false);
        wasStreamingRef.current = false;
      }, 500);
    }

    return () => {
      if (autoCollapseTimeoutRef.current) {
        clearTimeout(autoCollapseTimeoutRef.current);
      }
    };
  }, [isComplete, autoCollapseOnComplete]);

  // ============================================================================
  // Reset state when text is cleared
  // ============================================================================
  useEffect(() => {
    if (!text || text.length === 0) {
      parserContextRef.current = createParserContext();
      lastTextLengthRef.current = 0;
      setFormattedText("");
      setUserScrolledUp(false);
      lastScrollHeightRef.current = 0;
      wasStreamingRef.current = false;
    }
  }, [text]);

  // ============================================================================
  // Format text (JSON to human-readable)
  // ============================================================================
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
        setFormattedText(completeFormatted);
        return;
      }
    }
    setFormattedText(parserContextRef.current.lastOutput || text);
  }, [text, isStreaming, formatAsHuman]);

  // ============================================================================
  // Scroll handling
  // ============================================================================
  const checkIfAtBottom = useCallback(() => {
    const container = contentRef.current;
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const handleScroll = useCallback(() => {
    const container = contentRef.current;
    if (!container) return;

    const atBottom = checkIfAtBottom();
    const currentScrollHeight = container.scrollHeight;
    const isContentGrowth = currentScrollHeight !== lastScrollHeightRef.current;
    lastScrollHeightRef.current = currentScrollHeight;

    if (!isContentGrowth && !atBottom) {
      setUserScrolledUp(true);
    }

    if (atBottom && userScrolledUp) {
      setUserScrolledUp(false);
    }
  }, [checkIfAtBottom, userScrolledUp]);

  // Auto-scroll when text changes
  useEffect(() => {
    const container = contentRef.current;
    if (!container || userScrolledUp || !isOpen) return;

    requestAnimationFrame(() => {
      if (contentRef.current) {
        lastScrollHeightRef.current = contentRef.current.scrollHeight;
        contentRef.current.scrollTo({
          top: contentRef.current.scrollHeight,
          behavior: "auto",
        });
      }
    });
  }, [displayText, isOpen, userScrolledUp]);

  // Scroll to bottom on mount/open
  useEffect(() => {
    if (isOpen) {
      const container = contentRef.current;
      if (container) {
        requestAnimationFrame(() => {
          if (contentRef.current) {
            contentRef.current.scrollTo({
              top: contentRef.current.scrollHeight,
              behavior: "auto",
            });
            lastScrollHeightRef.current = contentRef.current.scrollHeight;
          }
        });
      }
    }
  }, [isOpen]);

  // Attach scroll listener
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // ============================================================================
  // Handlers
  // ============================================================================
  const handleValueChange = (value: string) => {
    const newIsOpen = value === id;
    setIsOpen(newIsOpen);
    onToggle?.(newIsOpen);
  };

  const handleScrollToBottom = useCallback(() => {
    setUserScrolledUp(false);
    const container = contentRef.current;
    if (container) {
      lastScrollHeightRef.current = container.scrollHeight;
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "smooth",
      });
    }
  }, []);

  // ============================================================================
  // Render
  // ============================================================================
  // Determine icon - handle both string literals and custom React nodes.
  const lucideIcon: LucideIcon | null =
    typeof icon === "string"
      ? icon === "brain"
        ? isComplete
          ? CheckCircle2
          : Loader2
        : icon === "sparkles"
          ? Sparkles
          : icon === "database"
            ? isComplete
              ? CheckCircle2
              : Database
            : icon === "spinner"
              ? isComplete
                ? CheckCircle2
                : Loader2
              : icon === "check"
                ? CheckCircle2
                : null
      : null;

  const customIconNode = typeof icon === "string" ? null : icon;

  const isEmpty = !displayText || displayText.length === 0;

  return (
    <AccordionPrimitive.Root
      type="single"
      collapsible
      value={isOpen ? id : ""}
      onValueChange={handleValueChange}
      className={cn("w-full", className)}
    >
      <AccordionPrimitive.Item value={id} className="border rounded-lg overflow-hidden">
        <AccordionPrimitive.Header className="flex">
          <AccordionPrimitive.Trigger
            className={cn(
              "flex flex-1 items-center justify-between gap-3 px-4 py-3",
              "text-left text-sm font-medium transition-all",
              "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "[&[data-state=open]>svg.chevron]:rotate-180"
            )}
          >
            <div className="flex items-center gap-2">
              {lucideIcon ? (
                <Icon
                  icon={lucideIcon}
                  size="sm"
                  className={cn(
                    isStreaming && typeof icon === "string" && (icon === "spinner" || icon === "brain")
                      ? "animate-spin"
                      : "",
                    isStreaming && typeof icon === "string" ? "text-primary" : "",
                    iconClassName
                  )}
                />
              ) : (
                customIconNode
              )}

              <span>{title}</span>
            </div>
            <Icon
              icon={ChevronDownIcon}
              size="sm"
              className="chevron text-muted-foreground shrink-0 transition-transform duration-200"
            />
          </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>

        <AccordionPrimitive.Content className="app-accordion-content">
          <div className="relative">
            <div
              ref={contentRef}
              className={cn(
                "overflow-y-auto overscroll-contain px-4 pb-4",
                "scrollbar-thin scrollbar-thumb-muted scrollbar-track-transparent"
              )}
              style={{ maxHeight }}
            >
              {isEmpty ? (
                <p className="text-muted-foreground text-sm italic">
                  {isStreaming ? emptyStreamingMessage : "Waiting for AI response..."}
                </p>
              ) : (
                <div
                  className={cn(
                    "text-sm text-muted-foreground leading-relaxed",
                    bodyClassName
                  )}
                >
                  {formatThinkingText(displayText)}
                  {showCursor && isStreaming && (
                    <StreamingCursor isStreaming={isStreaming} color="primary" />
                  )}
                </div>
              )}
            </div>

            {/* Scroll to bottom button */}
            {userScrolledUp && isStreaming && isOpen && (
              <button
                onClick={handleScrollToBottom}
                className={cn(
                  "absolute bottom-2 left-1/2 -translate-x-1/2 z-10",
                  "px-3 py-1.5 rounded-full",
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
        </AccordionPrimitive.Content>
      </AccordionPrimitive.Item>
    </AccordionPrimitive.Root>
  );
}

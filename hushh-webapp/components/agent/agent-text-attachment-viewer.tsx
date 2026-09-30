"use client";

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { ChevronDown, ChevronUp, Copy, PencilLine, Search } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { formatTextAttachmentSize } from "@/lib/agent/large-text-attachment";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { copyToClipboard } from "@/lib/utils/clipboard";
import { cn } from "@/lib/utils";

/**
 * A long pasted text, read in place without leaving the chat.
 *
 * Phone: the canonical bottom Sheet at a large detent, modal, with its own
 * scroll box and a drag handle that swipes it away. Desktop: a floating
 * right-side panel that is NOT modal, so the transcript keeps scrolling and
 * the composer keeps typing beside it. It is not opened from inside another
 * modal, so no ancestor scroll lock can swallow its wheel events (the failure
 * of a non-modal dialog opened from a modal); the body is its own scroller.
 *
 * The text is whatever the chip already holds in memory (the composer draft
 * or the sealed chat history). The viewer never logs, stores, or sends it;
 * Copy writes it to the clipboard only when the person asks.
 *
 * Large text: lines render in chunks. A chunk builds its rows only when it
 * nears the scrollport (or holds the active find match), and a built chunk is
 * `content-visibility: auto`, so a 50k-character paste costs a few hundred
 * rows at open and nothing per scroll frame.
 */

/**
 * The frame both the viewer and the editor sit in: a large bottom sheet that
 * stops 40px under the safe area and lifts above the keyboard, or a floating
 * panel inset from the window's right edge.
 */
export const TEXT_ATTACHMENT_SHEET_FRAME = {
  sheet:
    "h-[calc(100dvh-var(--app-safe-area-top-effective,0px)-2.5rem-var(--kb-height,0px))] max-h-[calc(100dvh-var(--app-safe-area-top-effective,0px)-2.5rem-var(--kb-height,0px))]",
  // Floats inset from the edges; the primitive's safe-area padding stays, so
  // on an iPad shell the header clears the status bar.
  panel:
    "inset-y-3 right-3 h-auto w-[min(40rem,52vw)] rounded-[var(--app-card-radius-feature)] border sm:max-w-none",
} as const;

const CHUNK_LINES = 200;
const INITIAL_BUILT_CHUNKS = 2;
const MAX_FIND_MATCHES = 5_000;
const CHUNK_ROOT_MARGIN = "1200px 0px";
const ESTIMATED_CHARS_PER_ROW = 72;

export function splitTextLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Monospace for text that is laid out by its characters (code, JSON, logs,
 * tables, indented outlines); the body face for prose. Reads a bounded sample
 * so the decision is constant-time for any paste.
 */
export function looksLikeCodeText(text: string): boolean {
  const sample = text.slice(0, 4_000);
  if (!sample.trim()) return false;
  if (/^\s*[[{<]/.test(sample) || sample.includes("```")) return true;
  const lines = splitTextLines(sample).filter((line) => line.trim());
  const indented = lines.filter((line) => /^(\t| {2,})\S/.test(line)).length;
  const symbols = sample.match(/[{}();=<>[\]|$#\\]/g)?.length ?? 0;
  return indented / lines.length >= 0.25 || symbols / sample.length >= 0.04;
}

export type TextFindMatch = { line: number; start: number };

/**
 * Case-insensitive matches, line by line (the query is one line, so a match
 * never spans a break). A line whose lower-case form changes length (a few
 * Unicode letters do) is searched case-sensitively so offsets stay exact.
 */
export function findTextMatches(
  lines: readonly string[],
  query: string,
  limit: number = MAX_FIND_MATCHES,
): { matches: TextFindMatch[]; truncated: boolean } {
  const matches: TextFindMatch[] = [];
  if (!query) return { matches, truncated: false };
  const needle = query.toLowerCase();
  const exactCase = needle.length !== query.length;
  for (let line = 0; line < lines.length; line += 1) {
    const original = lines[line]!;
    const lowered = original.toLowerCase();
    const caseless = !exactCase && lowered.length === original.length;
    const haystack = caseless ? lowered : original;
    const term = caseless ? needle : query;
    let from = haystack.indexOf(term);
    while (from !== -1) {
      if (matches.length === limit) return { matches, truncated: true };
      matches.push({ line, start: from });
      from = haystack.indexOf(term, from + term.length);
    }
  }
  return { matches, truncated: false };
}

type ChunkMatches = ReadonlyMap<number, readonly number[]>;

function estimateChunkHeight(lines: readonly string[], lineHeight: number): number {
  let rows = 0;
  for (const line of lines) {
    rows += Math.max(1, Math.ceil(line.length / ESTIMATED_CHARS_PER_ROW));
  }
  return rows * lineHeight;
}

function LineText({
  text,
  starts,
  length,
  activeStart,
}: {
  text: string;
  starts: readonly number[] | undefined;
  length: number;
  activeStart: number;
}) {
  if (!starts?.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const start of starts) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    const active = start === activeStart;
    parts.push(
      <mark
        key={start}
        data-find-match=""
        data-active-match={active ? "true" : undefined}
        className={cn(
          "rounded-[3px] text-inherit",
          active
            ? "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
            : "bg-[color:var(--app-accent-tint)]",
        )}
      >
        {text.slice(start, start + length)}
      </mark>,
    );
    cursor = start + length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

const TextChunk = memo(function TextChunk({
  lines,
  firstLine,
  gutter,
  lineHeight,
  matches,
  queryLength,
  activeLine,
  activeStart,
  initiallyBuilt,
  rootRef,
}: {
  lines: readonly string[];
  firstLine: number;
  gutter: boolean;
  lineHeight: number;
  matches: ChunkMatches | undefined;
  queryLength: number;
  /** Absolute line index of the active match when it is in this chunk, else -1. */
  activeLine: number;
  activeStart: number;
  initiallyBuilt: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [nearViewport, setNearViewport] = useState(initiallyBuilt);
  const built = nearViewport || activeLine >= 0;
  const estimatedHeight = useMemo(
    () => estimateChunkHeight(lines, lineHeight),
    [lines, lineHeight],
  );

  useEffect(() => {
    if (built) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { root: rootRef.current, rootMargin: CHUNK_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [built, rootRef]);

  if (!built) {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        data-text-chunk="pending"
        style={{ height: estimatedHeight }}
      />
    );
  }

  return (
    <div
      ref={ref}
      data-text-chunk="built"
      style={{
        contentVisibility: "auto",
        containIntrinsicSize: `auto ${estimatedHeight}px`,
      }}
    >
      {lines.map((line, index) => {
        const absolute = firstLine + index;
        return (
          <div
            key={absolute}
            data-line={absolute + 1}
            style={{ minHeight: lineHeight }}
            className={cn(
              gutter &&
                "relative pl-[calc(var(--text-viewer-gutter)+0.875rem)] before:absolute before:left-0 before:w-[var(--text-viewer-gutter)] before:select-none before:text-right before:text-[color:var(--app-tertiary-label)] before:content-[attr(data-line)]",
            )}
          >
            <LineText
              text={line}
              starts={matches?.get(absolute)}
              length={queryLength}
              activeStart={absolute === activeLine ? activeStart : -1}
            />
          </div>
        );
      })}
    </div>
  );
});

function TextAttachmentViewerBody({
  name,
  text,
  sheet,
  findInputRef,
  scrollerRef,
  onEditAndResend,
}: {
  name: string;
  text: string;
  /** A bottom sheet reaches the home indicator; the panel's frame pads it. */
  sheet: boolean;
  findInputRef: RefObject<HTMLInputElement | null>;
  scrollerRef: RefObject<HTMLDivElement | null>;
  onEditAndResend?: () => void;
}) {
  const lines = useMemo(() => splitTextLines(text), [text]);
  const code = useMemo(() => looksLikeCodeText(text), [text]);
  const lineHeight = code ? 20 : 24;
  const summary = useMemo(
    () =>
      formatTextAttachmentSize({
        byteSize: new TextEncoder().encode(text).byteLength,
        lineCount: text ? lines.length : 0,
      }),
    [lines.length, text],
  );
  const chunks = useMemo(() => {
    const result: { firstLine: number; lines: string[] }[] = [];
    for (let first = 0; first < lines.length; first += CHUNK_LINES) {
      result.push({ firstLine: first, lines: lines.slice(first, first + CHUNK_LINES) });
    }
    return result;
  }, [lines]);

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const { matches, truncated } = useMemo(
    () => findTextMatches(lines, deferredQuery),
    [deferredQuery, lines],
  );
  const matchesByChunk = useMemo(() => {
    const byChunk = new Map<number, Map<number, number[]>>();
    for (const match of matches) {
      const chunk = Math.floor(match.line / CHUNK_LINES);
      let chunkMatches = byChunk.get(chunk);
      if (!chunkMatches) {
        chunkMatches = new Map();
        byChunk.set(chunk, chunkMatches);
      }
      const starts = chunkMatches.get(match.line);
      if (starts) starts.push(match.start);
      else chunkMatches.set(match.line, [match.start]);
    }
    return byChunk;
  }, [matches]);

  // The active match belongs to the query it was chosen for, so a new query
  // starts at its first match without a reset effect.
  const [active, setActive] = useState({ query: "", index: 0 });
  const activeIndex =
    active.query === deferredQuery && active.index < matches.length ? active.index : 0;
  const activeMatch = matches.length ? matches[activeIndex] : undefined;

  const step = useCallback(
    (direction: 1 | -1) => {
      if (!matches.length) return;
      setActive({
        query: deferredQuery,
        index: (activeIndex + direction + matches.length) % matches.length,
      });
    },
    [activeIndex, deferredQuery, matches.length],
  );

  // Bring the active match into the scroll box: one read, one write, and
  // only when it is outside the visible band. Scrolls the box itself, never
  // an ancestor (scrollIntoView would also move the sheet and the page).
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !activeMatch) return;
    const mark = scroller.querySelector<HTMLElement>("[data-active-match]");
    if (!mark) return;
    const box = scroller.getBoundingClientRect();
    const rect = mark.getBoundingClientRect();
    const margin = Math.min(96, box.height / 4);
    if (rect.top >= box.top + margin && rect.bottom <= box.bottom - margin) return;
    scroller.scrollTop += rect.top - box.top - box.height / 2 + rect.height / 2;
  }, [activeMatch, scrollerRef]);

  const copyAll = async () => {
    const copied = await copyToClipboard(text);
    if (copied) toast.success("Copied the whole text.");
    else toast.error("Could not copy the text.");
  };

  const onFindKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  };

  const matchLabel = !deferredQuery
    ? null
    : matches.length
      ? `${activeIndex + 1} of ${matches.length}${truncated ? "+" : ""}`
      : "No matches";
  const gutterDigits = String(lines.length).length;

  return (
    <>
      <div className="shrink-0 px-4 pt-4 pr-14 sm:pt-5">
        <SheetTitle className="truncate text-[17px] leading-6">{name}</SheetTitle>
        <SheetDescription
          data-testid="text-attachment-viewer-summary"
          className="mt-0.5 text-[13px] leading-5 tabular-nums"
        >
          {summary}
        </SheetDescription>
      </div>
      <div
        data-testid="text-attachment-viewer-toolbar"
        className="flex shrink-0 items-center gap-1 px-4 pb-3 pt-3"
      >
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[color:var(--app-secondary-label)]"
            aria-hidden="true"
          />
          <Input
            ref={findInputRef}
            type="text"
            inputMode="search"
            enterKeyHint="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onFindKeyDown}
            placeholder="Find in text"
            aria-label="Find in text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className={cn("pl-9", matchLabel && "pr-24")}
          />
          {matchLabel ? (
            <span
              aria-live="polite"
              data-testid="text-attachment-viewer-match-count"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs tabular-nums text-[color:var(--app-secondary-label)]"
            >
              {matchLabel}
            </span>
          ) : null}
        </div>
        {deferredQuery ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-touch"
              aria-label="Previous match"
              disabled={!matches.length}
              onClick={() => step(-1)}
            >
              <ChevronUp aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-touch"
              aria-label="Next match"
              disabled={!matches.length}
              onClick={() => step(1)}
            >
              <ChevronDown aria-hidden="true" />
            </Button>
          </>
        ) : null}
        <Button type="button" variant="secondary" size="compact" onClick={copyAll}>
          <Copy aria-hidden="true" />
          Copy
        </Button>
      </div>
      <div
        ref={scrollerRef}
        tabIndex={0}
        role="region"
        aria-label={`${name}, full text`}
        data-testid="text-attachment-viewer-body"
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-[color:var(--app-separator)] px-4 pt-3 outline-none [-webkit-overflow-scrolling:touch] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-focus-ring)]",
          // The footer, when there is one, owns the bottom inset instead.
          onEditAndResend
            ? "pb-5"
            : sheet
              ? "pb-[calc(1.25rem+var(--app-safe-area-bottom-effective,0px))]"
              : "pb-5",
        )}
      >
        <div
          data-text-viewer-face={code ? "code" : "prose"}
          style={{ ["--text-viewer-gutter" as string]: `${gutterDigits}ch` }}
          className={cn(
            "select-text whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] [tab-size:4]",
            // The app's `font-mono` token resolves to the body face by
            // design, so code-like text names the platform's monospace
            // directly: indentation and columns only line up in a fixed pitch.
            code
              ? "font-[ui-monospace,SFMono-Regular,Menlo,Consolas,monospace] text-[13px] leading-5 [font-variant-ligatures:none]"
              : "text-[15px] leading-6",
          )}
        >
          {chunks.map((chunk, index) => {
            const inChunk = activeMatch && Math.floor(activeMatch.line / CHUNK_LINES) === index;
            return (
              <TextChunk
                key={chunk.firstLine}
                lines={chunk.lines}
                firstLine={chunk.firstLine}
                gutter={code}
                lineHeight={lineHeight}
                matches={matchesByChunk.get(index)}
                queryLength={deferredQuery.length}
                activeLine={inChunk ? activeMatch.line : -1}
                activeStart={inChunk ? activeMatch.start : -1}
                initiallyBuilt={index < INITIAL_BUILT_CHUNKS}
                rootRef={scrollerRef}
              />
            );
          })}
        </div>
      </div>
      {onEditAndResend ? (
        // A sent message never changes: its one action is a NEW turn built
        // from an edited copy.
        <div
          data-testid="text-attachment-viewer-footer"
          className={cn(
            "shrink-0 border-t border-[color:var(--app-separator)] px-4 pt-3",
            sheet ? "pb-[calc(0.75rem+var(--app-safe-area-bottom-effective,0px))]" : "pb-3",
          )}
        >
          <Button
            type="button"
            size="standard"
            className="w-full"
            onClick={onEditAndResend}
          >
            <PencilLine aria-hidden="true" />
            Edit and send again
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function AgentTextAttachmentViewer({
  open,
  onOpenChange,
  name,
  text,
  returnFocusRef,
  onEditAndResend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  text: string;
  /** The chip that opened the viewer; focus goes back to it on close. */
  returnFocusRef: RefObject<HTMLElement | null>;
  /** Offered on a sent message: open an edited copy as a new turn. */
  onEditAndResend?: () => void;
}) {
  const isMobile = useIsMobile();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={isMobile}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        showOverlay={isMobile}
        // The body is its own scroller inside a fixed frame, so only the
        // handle drags the sheet down; a drag in the text scrolls the text.
        contentDragDismiss={false}
        data-testid="text-attachment-viewer"
        data-presentation={isMobile ? "sheet" : "panel"}
        className={cn(
          "gap-0 overflow-hidden p-0 motion-reduce:animate-none motion-reduce:transition-none",
          isMobile ? TEXT_ATTACHMENT_SHEET_FRAME.sheet : TEXT_ATTACHMENT_SHEET_FRAME.panel,
        )}
        onOpenAutoFocus={(event) => {
          // Focus the text, not the find field: on a phone a focused field
          // raises the keyboard over what the person opened to read.
          event.preventDefault();
          scrollerRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // Return focus to the chip unless the person has already moved on
          // (typing in the composer beside the desktop panel, say).
          const current = document.activeElement;
          if (
            !current ||
            current === document.body ||
            contentRef.current?.contains(current)
          ) {
            returnFocusRef.current?.focus({ preventScroll: true });
          }
        }}
        onInteractOutside={(event) => {
          if (isMobile) return;
          // Beside the desktop panel the chat stays usable: scrolling,
          // typing, and tapping the transcript keep the panel open. Its own
          // chip toggles it closed; another attachment chip replaces it.
          const target = event.target instanceof Element ? event.target : null;
          if (target && returnFocusRef.current?.contains(target)) {
            event.preventDefault();
            return;
          }
          if (target?.closest("[data-text-attachment-trigger]")) return;
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
            event.preventDefault();
            findInputRef.current?.focus();
            findInputRef.current?.select();
          }
        }}
      >
        {/* Radix unmounts the content once closed, so the body (and its line
          * split and find index) exists only while the viewer is on screen. */}
        <div ref={contentRef} className="flex min-h-0 flex-1 flex-col">
          <TextAttachmentViewerBody
            name={name}
            text={text}
            sheet={isMobile}
            findInputRef={findInputRef}
            scrollerRef={scrollerRef}
            onEditAndResend={onEditAndResend}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

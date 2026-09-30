"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import { ChevronDown, ChevronUp, Code2, FileText, MoreHorizontal, Search, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  TEXT_ATTACHMENT_SHEET_FRAME,
  looksLikeCodeText,
} from "@/components/agent/agent-text-attachment-viewer";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  PASTED_TEXT_ATTACHMENT_NAME,
  countTextLines,
  formatTextAttachmentSize,
  getTextAttachmentTitle,
  type PendingTextAttachment,
} from "@/lib/agent/large-text-attachment";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";

/**
 * A pasted text, edited in place.
 *
 * The editor is a plain, UNCONTROLLED textarea: the browser owns its value,
 * its caret and its undo stack, so a keystroke in a 100 KB paste costs the
 * browser's own edit and nothing else. React never re-renders the document on
 * input; line and size counts and find results are recomputed on a short
 * debounce after typing pauses.
 *
 * Find highlights are painted by a mirror layer behind the transparent
 * textarea: the same text, laid out with the same metrics, with each match
 * wrapped in a `<mark>`. It is built with DOM text nodes (never HTML parsing),
 * hidden while typing moves offsets, and rebuilt when the debounce fires.
 * Stepping between matches scrolls the textarea; it never moves the caret.
 *
 * The text lives only in this component's memory and in what `onCommit`
 * hands back. It is never logged, stored, or sent from here.
 */

const RECOMPUTE_DELAY_MS = 120;
const MAX_FIND_MATCHES = 5_000;

export type TextFindResult = { offsets: number[]; truncated: boolean };

/**
 * Case-insensitive match offsets in the whole text. When lower-casing changes
 * the text's length (a few Unicode letters do), the search falls back to the
 * exact case so every offset still points into the original.
 */
export function findTextOffsets(
  text: string,
  query: string,
  limit: number = MAX_FIND_MATCHES,
): TextFindResult {
  const offsets: number[] = [];
  if (!query) return { offsets, truncated: false };
  const needle = query.toLowerCase();
  const lowered = text.toLowerCase();
  const caseless = needle.length === query.length && lowered.length === text.length;
  const haystack = caseless ? lowered : text;
  const term = caseless ? needle : query;
  let from = haystack.indexOf(term);
  while (from !== -1) {
    if (offsets.length === limit) return { offsets, truncated: true };
    offsets.push(from);
    from = haystack.indexOf(term, from + term.length);
  }
  return { offsets, truncated: false };
}

function describeText(text: string): string {
  return formatTextAttachmentSize({
    byteSize: new TextEncoder().encode(text).byteLength,
    lineCount: countTextLines(text),
  });
}

/**
 * Replace `[start, end)` through the editing pipeline, so the change joins
 * the textarea's own undo stack. `setRangeText` is the fallback where
 * `insertText` is unavailable; it edits correctly but is not undoable.
 */
function editTextarea(textarea: HTMLTextAreaElement, start: number, end: number, text: string) {
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(start, end);
  let inserted = false;
  try {
    inserted =
      typeof document.execCommand === "function" &&
      document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }
  if (!inserted) textarea.setRangeText(text, start, end, "end");
}

// Shared by the textarea and its mirror: any difference in these metrics
// moves a highlight off its word.
const EDITOR_TEXT =
  "m-0 whitespace-pre-wrap border-0 px-4 pt-3 [overflow-wrap:anywhere] [tab-size:4]";
// Below 768px the app forces every textarea to 16px (globals.css, so iOS
// never zooms into a field); the faces say so rather than lose to it.
const EDITOR_FACE = {
  code: "font-[ui-monospace,SFMono-Regular,Menlo,Consolas,monospace] text-[16px] leading-6 md:text-[13px] md:leading-5 [font-variant-ligatures:none]",
  prose: "text-[16px] leading-6 md:text-[15px]",
} as const;

// The textarea is the authority for how its text lays out. The mirror copies
// these from its computed style at every paint, so no stylesheet rule that
// reaches one and not the other (the 16px rule above did) can move a
// highlight off its word.
const MIRRORED_TEXT_METRICS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontStretch",
  "fontFeatureSettings",
  "fontVariationSettings",
  "fontVariantLigatures",
  "fontKerning",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "textTransform",
  "textIndent",
  "paddingTop",
  "paddingLeft",
  "paddingBottom",
] as const;

type EditorPurpose = "draft" | "resend";

function TextAttachmentEditorBody({
  name,
  initialText,
  purpose,
  sheet,
  textareaRef,
  findInputRef,
  confirmingDiscard,
  onCancel,
  onCommit,
  onKeepEditing,
  onDiscard,
}: {
  name: string;
  initialText: string;
  purpose: EditorPurpose;
  sheet: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  findInputRef: RefObject<HTMLInputElement | null>;
  confirmingDiscard: boolean;
  onCancel: () => void;
  onCommit: () => void;
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const mirrorContentRef = useRef<HTMLDivElement | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const queryRef = useRef("");
  const resultRef = useRef<TextFindResult>({ offsets: [], truncated: false });
  const activeRef = useRef(0);

  const [summary, setSummary] = useState(() => describeText(initialText));
  const [blank, setBlank] = useState(() => !initialText.trim());
  const [query, setQuery] = useState("");
  const [find, setFind] = useState<{ count: number; truncated: boolean; active: number }>({
    count: 0,
    truncated: false,
    active: 0,
  });
  const [code, setCode] = useState(() => looksLikeCodeText(initialText));
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");

  const syncMirrorScroll = useCallback(() => {
    if (!queryRef.current) return;
    const textarea = textareaRef.current;
    const content = mirrorContentRef.current;
    if (!textarea || !content) return;
    content.style.transform = `translateY(${-textarea.scrollTop}px)`;
  }, [textareaRef]);

  // The mirror lays out in the textarea's CONTENT width, which a classic
  // scrollbar narrows, and in its computed text metrics; match both so
  // wrapped lines break at the same place.
  const syncMirrorLayout = useCallback(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    const computed = getComputedStyle(textarea);
    for (const property of MIRRORED_TEXT_METRICS) mirror.style[property] = computed[property];
    const scrollbar = Math.max(0, textarea.offsetWidth - textarea.clientWidth);
    mirror.style.paddingRight = `calc(${computed.paddingRight} + ${scrollbar}px)`;
  }, [textareaRef]);

  const revealActiveMatch = useCallback(() => {
    const textarea = textareaRef.current;
    const content = mirrorContentRef.current;
    const mark = content?.querySelector<HTMLElement>("mark[data-active-match]");
    if (!textarea || !mark) return;
    const top = mark.offsetTop;
    const bottom = top + mark.offsetHeight;
    const margin = Math.min(96, textarea.clientHeight / 4);
    if (top >= textarea.scrollTop + margin && bottom <= textarea.scrollTop + textarea.clientHeight - margin) {
      return;
    }
    textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 2 + mark.offsetHeight / 2);
    syncMirrorScroll();
  }, [syncMirrorScroll, textareaRef]);

  const paintMatches = useCallback(
    (text: string) => {
      const content = mirrorContentRef.current;
      const mirror = mirrorRef.current;
      if (!content || !mirror) return;
      const { offsets } = resultRef.current;
      const length = queryRef.current.length;
      if (!offsets.length) {
        content.replaceChildren();
        mirror.style.visibility = "hidden";
        return;
      }
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      offsets.forEach((start, index) => {
        if (start > cursor) fragment.append(text.slice(cursor, start));
        const mark = document.createElement("mark");
        mark.dataset.findMatch = "";
        if (index === activeRef.current) mark.dataset.activeMatch = "";
        mark.textContent = text.slice(start, start + length);
        fragment.append(mark);
        cursor = start + length;
      });
      // A textarea keeps a line box for a trailing newline; so must the mirror.
      fragment.append(`${text.slice(cursor)}\n`);
      content.replaceChildren(fragment);
      syncMirrorLayout();
      syncMirrorScroll();
      mirror.style.visibility = "visible";
    },
    [syncMirrorScroll, syncMirrorLayout],
  );

  /** One pass over the current text: counts, find results, highlights. */
  const recompute = useCallback(
    ({ reveal }: { reveal: boolean }) => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const textarea = textareaRef.current;
      if (!textarea) return;
      const text = textarea.value;
      resultRef.current = findTextOffsets(text, queryRef.current);
      const count = resultRef.current.offsets.length;
      activeRef.current = count ? Math.min(activeRef.current, count - 1) : 0;
      setSummary(describeText(text));
      setBlank(!text.trim());
      setFind({ count, truncated: resultRef.current.truncated, active: activeRef.current });
      paintMatches(text);
      if (reveal) revealActiveMatch();
    },
    [paintMatches, revealActiveMatch, textareaRef],
  );

  const schedule = useCallback(
    (reveal: boolean) => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => recompute({ reveal }), RECOMPUTE_DELAY_MS);
    },
    [recompute],
  );

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncMirrorLayout());
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [syncMirrorLayout, textareaRef]);

  // Changing the face re-wraps the text; repaint so highlights follow.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea && queryRef.current) paintMatches(textarea.value);
  }, [code, paintMatches, textareaRef]);

  useEffect(() => {
    if (confirmingDiscard) keepEditingRef.current?.focus();
  }, [confirmingDiscard]);

  const onInput = () => {
    // Offsets after the caret just moved: hide the highlights until the
    // debounced pass rebuilds them, rather than paint them on the wrong text.
    if (mirrorRef.current && queryRef.current) mirrorRef.current.style.visibility = "hidden";
    schedule(false);
  };

  const onQueryChange = (value: string) => {
    setQuery(value);
    queryRef.current = value;
    activeRef.current = 0;
    schedule(true);
  };

  const step = (direction: 1 | -1) => {
    // Typing may have moved the offsets since the last pass; settle them first.
    if (timerRef.current !== null) recompute({ reveal: false });
    const { offsets } = resultRef.current;
    if (!offsets.length) return;
    const content = mirrorContentRef.current;
    const marks = content?.querySelectorAll<HTMLElement>("mark[data-find-match]");
    marks?.[activeRef.current]?.removeAttribute("data-active-match");
    activeRef.current = (activeRef.current + direction + offsets.length) % offsets.length;
    marks?.[activeRef.current]?.setAttribute("data-active-match", "");
    setFind((current) => ({ ...current, active: activeRef.current }));
    revealActiveMatch();
  };

  const replaceActive = () => {
    const textarea = textareaRef.current;
    recompute({ reveal: false });
    const start = resultRef.current.offsets[activeRef.current];
    if (!textarea || start === undefined) return;
    const returnTo = document.activeElement as HTMLElement | null;
    editTextarea(textarea, start, start + queryRef.current.length, replacement);
    returnTo?.focus({ preventScroll: true });
    recompute({ reveal: true });
  };

  const replaceAll = () => {
    const textarea = textareaRef.current;
    const term = queryRef.current;
    if (!textarea || !term) return;
    const text = textarea.value;
    const { offsets } = findTextOffsets(text, term, Number.POSITIVE_INFINITY);
    if (!offsets.length) return;
    let next = "";
    let cursor = 0;
    for (const start of offsets) {
      next += text.slice(cursor, start) + replacement;
      cursor = start + term.length;
    }
    next += text.slice(cursor);
    // One edit for the whole document: a single undo step reverses it.
    const returnTo = document.activeElement as HTMLElement | null;
    editTextarea(textarea, 0, text.length, next);
    textarea.setSelectionRange(0, 0);
    returnTo?.focus({ preventScroll: true });
    recompute({ reveal: true });
  };

  const onFindKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (timerRef.current !== null) recompute({ reveal: true });
    else step(event.shiftKey ? -1 : 1);
  };

  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onCommit();
    }
  };

  const matchLabel = !query
    ? null
    : find.count
      ? `${find.active + 1} of ${find.count}${find.truncated ? "+" : ""} ${find.count === 1 ? "match" : "matches"}`
      : "No matches";
  const commitLabel = purpose === "resend" ? "Send" : "Done";
  const face = code ? EDITOR_FACE.code : EDITOR_FACE.prose;
  const bottomPad = sheet
    ? "pb-[calc(1.25rem+var(--app-safe-area-bottom-effective,0px))]"
    : "pb-5";

  return (
    <>
      {/* One row, three columns: the two actions sit on equal insets and the
        * title is centred on the sheet, whatever the actions' widths. */}
      <div
        data-testid="text-attachment-editor-header"
        className="grid h-13 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-2"
      >
        {confirmingDiscard ? (
          <>
            <Button
              ref={keepEditingRef}
              type="button"
              variant="ghost"
              size="compact"
              className="justify-self-start px-2"
              onClick={onKeepEditing}
            >
              Keep editing
            </Button>
            <div className="min-w-0 text-center">
              <p role="alert" className="truncate text-[15px] font-semibold leading-5">
                Discard changes?
              </p>
              {/* The dialog keeps its name while it asks. */}
              <SheetTitle className="sr-only">{name}</SheetTitle>
              <SheetDescription className="sr-only">{summary}</SheetDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="compact"
              className="justify-self-end px-2 text-[color:var(--app-destructive)] hover:bg-[color:var(--app-neutral-fill)]"
              onClick={onDiscard}
            >
              Discard
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="compact"
              data-testid="text-attachment-editor-cancel"
              className="justify-self-start px-2"
              onClick={onCancel}
            >
              Cancel
            </Button>
            {/* One subtitle slot: the size, or while finding, the find
              * position (so the find field keeps its whole width for the
              * query at 320px). The size stays the dialog's description. */}
            <div className="min-w-0 max-w-[min(18rem,52vw)] text-center">
              <SheetTitle className="truncate text-[15px] leading-5">{name}</SheetTitle>
              <SheetDescription
                data-testid="text-attachment-editor-summary"
                className={cn("truncate text-[12px] leading-4 tabular-nums", matchLabel && "sr-only")}
              >
                {summary}
              </SheetDescription>
              {matchLabel ? (
                <p
                  aria-hidden="true"
                  data-testid="text-attachment-editor-match-count"
                  className="truncate text-[12px] leading-4 tabular-nums text-[color:var(--app-secondary-label)]"
                >
                  {matchLabel}
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="compact"
              data-testid="text-attachment-editor-commit"
              className="justify-self-end px-2"
              disabled={blank && purpose === "resend"}
              onClick={onCommit}
            >
              {commitLabel}
            </Button>
          </>
        )}
      </div>
      <div
        data-testid="text-attachment-editor-toolbar"
        className="flex shrink-0 items-center gap-1 px-4 pb-3"
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
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onFindKeyDown}
            placeholder="Find in text"
            aria-label="Find in text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="pl-9"
          />
          {/* Always mounted, so a screen reader hears each new position. */}
          <span aria-live="polite" className="sr-only">
            {matchLabel ?? ""}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-label="Previous match"
          disabled={!find.count}
          onClick={() => step(-1)}
        >
          <ChevronUp aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-label="Next match"
          disabled={!find.count}
          onClick={() => step(1)}
        >
          <ChevronDown aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-label="Replace and text options"
          aria-expanded={replaceOpen}
          aria-controls="text-attachment-editor-options"
          className={cn(replaceOpen && "bg-[color:var(--app-accent-tint)]")}
          onClick={() => setReplaceOpen((open) => !open)}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </div>
      {replaceOpen ? (
        <div
          id="text-attachment-editor-options"
          data-testid="text-attachment-editor-options"
          className="flex shrink-0 items-center gap-1 px-4 pb-3"
        >
          <Input
            type="text"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            placeholder="Replace with"
            aria-label="Replace with"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={!find.count}
            onClick={replaceActive}
          >
            Replace
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="compact"
            aria-label="Replace all"
            disabled={!find.count}
            onClick={replaceAll}
          >
            All
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            aria-label="Monospace"
            aria-pressed={code}
            className={cn(code && "bg-[color:var(--app-accent-tint)]")}
            onClick={() => setCode((current) => !current)}
          >
            <Code2 aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      <div
        data-testid="text-attachment-editor-body"
        data-text-editor-face={code ? "code" : "prose"}
        className="relative min-h-0 flex-1 border-t border-[color:var(--app-separator)]"
      >
        <div
          ref={mirrorRef}
          aria-hidden="true"
          data-testid="text-attachment-editor-highlights"
          style={{ visibility: "hidden" }}
          className={cn(
            EDITOR_TEXT,
            face,
            bottomPad,
            "pointer-events-none absolute inset-0 overflow-hidden text-transparent",
            "[&_mark]:rounded-[3px] [&_mark]:bg-[color:var(--app-accent-tint)] [&_mark]:text-transparent",
            "[&_mark[data-active-match]]:bg-[color:color-mix(in_srgb,var(--app-accent)_38%,transparent)] [&_mark[data-active-match]]:outline [&_mark[data-active-match]]:outline-2 [&_mark[data-active-match]]:outline-[color:var(--app-accent)]",
          )}
        >
          <div ref={mirrorContentRef} />
        </div>
        <textarea
          ref={textareaRef}
          defaultValue={initialText}
          onInput={onInput}
          onScroll={syncMirrorScroll}
          onKeyDown={onEditorKeyDown}
          aria-label={`${name}, editable text`}
          data-testid="text-attachment-editor-textarea"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={cn(
            EDITOR_TEXT,
            face,
            bottomPad,
            "absolute inset-0 block size-full resize-none overflow-y-auto overscroll-contain bg-transparent text-foreground caret-[color:var(--app-accent)] outline-none [-webkit-overflow-scrolling:touch] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-focus-ring)]",
          )}
        />
      </div>
    </>
  );
}

/**
 * The editor sheet. Modal on every size: an unsaved edit beside a live
 * composer could be sent by mistake. It has no drag-to-dismiss, so a swipe
 * can never throw away an edit (the iOS rule for a sheet with changes);
 * Cancel, Escape and the scrim all ask before discarding.
 */
export function AgentTextAttachmentEditor({
  open,
  onOpenChange,
  name,
  initialText,
  purpose,
  onCommit,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  initialText: string;
  /** "draft" updates the composer's chip (Done); "resend" sends a new turn (Send). */
  purpose: EditorPurpose;
  /** Return false to keep the editor open (the edit could not be applied). */
  onCommit: (text: string) => boolean | void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const isMobile = useIsMobile();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const close = () => {
    setConfirmingDiscard(false);
    onOpenChange(false);
  };

  const requestClose = () => {
    const current = textareaRef.current?.value ?? initialText;
    if (current === initialText) {
      close();
      return;
    }
    setConfirmingDiscard(true);
  };

  const commit = () => {
    const text = textareaRef.current?.value ?? initialText;
    if (onCommit(text) === false) return;
    close();
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else requestClose();
      }}
      modal
    >
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        showCloseButton={false}
        dragDismiss={false}
        contentDragDismiss={false}
        // The sheet already lifts above the keyboard by --kb-height; the
        // keyboard manager must not also scroll the focused textarea (and
        // with it the page behind) into view.
        data-keyboard-anchor="bottom"
        data-testid="text-attachment-editor"
        data-presentation={isMobile ? "sheet" : "panel"}
        className={cn(
          // The container itself holds focus on a phone (keyboard down); it
          // is not a control, so it draws no ring around the sheet.
          "gap-0 overflow-hidden p-0 outline-none motion-reduce:animate-none motion-reduce:transition-none",
          isMobile ? TEXT_ATTACHMENT_SHEET_FRAME.sheet : TEXT_ATTACHMENT_SHEET_FRAME.panel,
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const textarea = textareaRef.current;
          if (!textarea) return;
          textarea.setSelectionRange(0, 0);
          textarea.scrollTop = 0;
          // A phone keeps its keyboard down until the person taps where they
          // want to edit; a desktop starts typing at the top straight away.
          if (isMobile) (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
          else textarea.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => {
          if (!confirmingDiscard) return;
          event.preventDefault();
          setConfirmingDiscard(false);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
            event.preventDefault();
            findInputRef.current?.focus();
            findInputRef.current?.select();
          }
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <TextAttachmentEditorBody
            name={name}
            initialText={initialText}
            purpose={purpose}
            sheet={isMobile}
            textareaRef={textareaRef}
            findInputRef={findInputRef}
            confirmingDiscard={confirmingDiscard}
            onCancel={requestClose}
            onCommit={commit}
            onKeepEditing={() => {
              setConfirmingDiscard(false);
              textareaRef.current?.focus({ preventScroll: true });
            }}
            onDiscard={close}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The composer's pending "Pasted text" chip. Tapping it opens the editor;
 * Done writes the edit back, so the chip's title, size and line count follow
 * the text that will be sent.
 */
export function AgentComposerTextAttachment({
  attachment,
  onChange,
  onRemove,
  onCollapse,
}: {
  attachment: PendingTextAttachment;
  /** The edited text; an empty edit removes the attachment. */
  onChange: (text: string) => void;
  onRemove: () => void;
  /** A draft restored mid-edit in the composer itself folds back to a chip. */
  onCollapse: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // The workspace re-renders on every composer keystroke; count lines once
  // per text, not once per keystroke.
  const size = useMemo(
    () =>
      formatTextAttachmentSize({
        byteSize: attachment.byteSize,
        lineCount: countTextLines(attachment.text),
      }),
    [attachment.byteSize, attachment.text],
  );
  return (
    <div
      className="relative mb-2 rounded-[18px] border border-foreground/[0.12] bg-foreground/[0.045] text-sm"
      data-testid="agent-chat-text-attachment"
    >
      <button
        ref={triggerRef}
        type="button"
        data-text-attachment-trigger=""
        className="relative flex min-h-13 w-full min-w-0 items-center gap-2 overflow-hidden rounded-[18px] py-2 pl-3 pr-13 text-left outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]"
        aria-haspopup={attachment.isExpanded ? undefined : "dialog"}
        aria-expanded={attachment.isExpanded ? true : open}
        aria-label={
          attachment.isExpanded
            ? "Text attachment open for editing"
            : `Edit pasted text, ${size}`
        }
        onClick={() => {
          if (attachment.isExpanded) {
            onCollapse();
            return;
          }
          setOpen(true);
        }}
      >
        <FileText className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{getTextAttachmentTitle(attachment.text)}</span>
          <span
            data-testid="agent-chat-text-attachment-size"
            className="block text-xs tabular-nums text-muted-foreground"
          >
            {PASTED_TEXT_ATTACHMENT_NAME} · {size}
            {attachment.isExpanded ? " · editing" : ""}
          </span>
        </span>
        <MaterialRipple variant="none" effect="glass" />
      </button>
      <Button
        type="button"
        size="icon-touch"
        variant="ghost"
        className="absolute right-1 top-1"
        aria-label="Remove text attachment"
        onClick={onRemove}
      >
        <X aria-hidden="true" />
      </Button>
      <AgentTextAttachmentEditor
        open={open}
        onOpenChange={setOpen}
        name={PASTED_TEXT_ATTACHMENT_NAME}
        initialText={attachment.text}
        purpose="draft"
        onCommit={(text) => onChange(text)}
        returnFocusRef={triggerRef}
      />
    </div>
  );
}

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Quote,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  Underline,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type RichEmailComposerProps = {
  id: string;
  value: string;
  disabled?: boolean;
  showPreviewOnFirstContent?: boolean;
  onChange: (value: string) => void;
};

type EmailBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "aligned"; alignment: "left" | "center" | "right"; lines: string[] }
  | { kind: "paragraph"; lines: string[] };

type FormattingAction =
  | "bold"
  | "italic"
  | "underline"
  | "heading"
  | "bullet-list"
  | "numbered-list"
  | "quote"
  | "align-left"
  | "align-center"
  | "align-right";

const FORMATTING_CONTROLS = [
  { label: "Bold", action: "bold" },
  { label: "Italic", action: "italic" },
  { label: "Underline", action: "underline" },
  { label: "Heading", action: "heading" },
  { label: "Bullet list", action: "bullet-list" },
  { label: "Numbered list", action: "numbered-list" },
  { label: "Quote", action: "quote" },
  { label: "Align left", action: "align-left" },
  { label: "Center text", action: "align-center" },
  { label: "Align right", action: "align-right" },
] as const satisfies ReadonlyArray<{ label: string; action: FormattingAction }>;

function formattingIcon(action: FormattingAction) {
  switch (action) {
    case "bold": return Bold;
    case "italic": return Italic;
    case "underline": return Underline;
    case "heading": return Heading2;
    case "bullet-list": return List;
    case "numbered-list": return ListOrdered;
    case "quote": return Quote;
    case "align-left": return AlignLeft;
    case "align-center": return AlignCenter;
    case "align-right": return AlignRight;
  }
}

const LINK_RE = /^\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)$/i;
const INLINE_TOKEN_RE =
  /(\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)|\*\*.+?\*\*|\+\+.+?\+\+|\b_[^_]+_\b|(?<!\*)\*(?!\*).+?(?<!\*)\*(?!\*))/g;

// Inline styles are intentional: the delivery HTML is rendered by Gmail and
// cannot rely on the application's Tailwind classes.
const EMAIL_BLOCK_STYLES = {
  h1: "margin:0 0 18px;font-size:24px;line-height:1.25",
  h2: "margin:0 0 14px;font-size:20px;line-height:1.3",
  h3: "margin:0 0 12px;font-size:16px;line-height:1.4",
  list: "margin:0 0 16px;padding-left:24px",
  listItem: "margin:0 0 8px",
  paragraph: "margin:0 0 16px;line-height:1.6",
  quote: "margin:0 0 16px;padding-left:16px;color:#5f6368",
} as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isSafeHref(value: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(value) && !/[\r\n]/.test(value);
}

/** Normalizes model JSON that accidentally exposes escaped line breaks or un-broken inline bullet lists. */
export function normalizeRichEmailText(value: string): string {
  let normalized = value.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
  normalized = normalized.replace(/([^\n])\s+(?:[\-•]|\*(?!\*))\s+/g, "$1\n- ");
  return normalized;
}

function parseBlocks(value: string): EmailBlock[] {
  const lines = normalizeRichEmailText(value).replaceAll("\r\n", "\n").split("\n");
  const blocks: EmailBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const alignment = line.match(/^:::(left|center|right)$/);
    if (alignment) {
      const alignedLines: string[] = [];
      index += 1;
      while (index < lines.length && (lines[index] ?? "") !== ":::") {
        alignedLines.push(lines[index] ?? "");
        index += 1;
      }
      if ((lines[index] ?? "") === ":::") index += 1;
      blocks.push({
        kind: "aligned",
        alignment: (alignment[1] ?? "left") as "left" | "center" | "right",
        lines: alignedLines,
      });
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "").length as 1 | 2 | 3,
        text: heading[2] ?? "",
      });
      index += 1;
      continue;
    }
    const bullet = line.match(/^[*•\-]\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = ordered
          ? (lines[index] ?? "").match(/^\d+[.)]\s+(.+)$/)
          : (lines[index] ?? "").match(/^[*•\-]\s+(.+)$/);
        if (!candidate) break;
        const cleanText = (candidate[1] ?? "").trim();
        items.push(cleanText);
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("> ")) {
        quoteLines.push((lines[index] ?? "").slice(2));
        index += 1;
      }
      blocks.push({ kind: "quote", lines: quoteLines });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim()) {
      const lineCandidate = lines[index] ?? "";
      if (
        paragraph.length > 0 &&
        (/^[*•\-]\s+/.test(lineCandidate) || /^\d+[.)]\s+/.test(lineCandidate))
      ) {
        break;
      }
      paragraph.push(lineCandidate);
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

function inlineHtml(value: string): string {
  const parts = value.split(INLINE_TOKEN_RE);
  return parts
    .map((part) => {
      if (!part) return "";
      const link = part.match(LINK_RE);
      const href = link?.[2] ?? "";
      const label = link?.[1] ?? "";
      if (link && isSafeHref(href)) {
        return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`;
      }
      if (part.startsWith("++") && part.endsWith("++")) {
        return `<u>${escapeHtml(part.slice(2, -2))}</u>`;
      }
      if (part.startsWith("*") && part.endsWith("*")) {
        return `<em>${escapeHtml(part.slice(1, -1))}</em>`;
      }
      return escapeHtml(part);
    })
    .join("");
}

function inlineNodes(value: string, keyPrefix: string): ReactNode[] {
  return value.split(INLINE_TOKEN_RE).flatMap((part, index) => {
    if (!part) return [];
    const key = `${keyPrefix}-${index}`;
    const link = part.match(LINK_RE);
    const href = link?.[2] ?? "";
    const label = link?.[1] ?? "";
    if (link && isSafeHref(href)) {
      return [
        <a
          className="font-medium text-primary underline underline-offset-2"
          href={href}
          key={key}
          rel="noreferrer"
          target="_blank"
        >
          {label}
        </a>,
      ];
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("++") && part.endsWith("++")) {
      return <u key={key}>{part.slice(2, -2)}</u>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <span key={key}>{part}</span>;
  });
}

/**
 * Creates Gmail-safe HTML from the reviewed editor value. This is deliberately
 * escape-first and deterministic; the delivery service independently sanitizes
 * this optional representation before it becomes part of the send HMAC.
 */
export function richEmailHtmlFromMarkdown(value: string): string {
  return parseBlocks(value)
    .map((block) => {
      if (block.kind === "heading") {
        return `<h${block.level} style="${EMAIL_BLOCK_STYLES[`h${block.level}`]}">${inlineHtml(block.text)}</h${block.level}>`;
      }
      if (block.kind === "list") {
        const tag = block.ordered ? "ol" : "ul";
        return `<${tag} style="${EMAIL_BLOCK_STYLES.list}">${block.items
          .map((item) => `<li style="${EMAIL_BLOCK_STYLES.listItem}">${inlineHtml(item)}</li>`)
          .join("")}</${tag}>`;
      }
      if (block.kind === "quote") {
        return `<blockquote style="${EMAIL_BLOCK_STYLES.quote}">${block.lines.map(inlineHtml).join("<br>")}</blockquote>`;
      }
      if (block.kind === "aligned") {
        return `<p style="${EMAIL_BLOCK_STYLES.paragraph};text-align:${block.alignment}">${block.lines
          .map(inlineHtml)
          .join("<br>")}</p>`;
      }
      return `<p style="${EMAIL_BLOCK_STYLES.paragraph}">${block.lines.map(inlineHtml).join("<br>")}</p>`;
    })
    .join("");
}

export function EmailRichTextPreview({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const isHtml = value.trim().startsWith("<") && value.includes(">");
  if (isHtml) {
    const cleanHtml = typeof window !== "undefined" ? sanitizePastedHtml(value) : value;
    return (
      <div
        className={cn(
          "space-y-3 text-[15px] leading-7 text-foreground [&_p]:mb-4 [&_p:last-child]:mb-0 [&_ul]:mb-4 [&_ul]:pl-6 [&_ul]:list-disc [&_ol]:mb-4 [&_ol]:pl-6 [&_ol]:list-decimal [&_li]:mb-1 [&_blockquote]:mb-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold",
          className,
        )}
        dangerouslySetInnerHTML={{ __html: cleanHtml }}
      />
    );
  }

  return (
    <div className={cn("space-y-3 text-[15px] leading-7 text-foreground", className)}>
      {parseBlocks(value).map((block, index) => {
        const key = `email-block-${index}`;
        if (block.kind === "heading") {
          const Tag = `h${block.level}` as "h1" | "h2" | "h3";
          return (
            <Tag
              className={cn(
                "font-semibold tracking-[-0.01em]",
                block.level === 1 && "text-xl",
                block.level === 2 && "text-lg",
                block.level === 3 && "text-base",
              )}
              key={key}
            >
              {inlineNodes(block.text, key)}
            </Tag>
          );
        }
        if (block.kind === "list") {
          const Tag = block.ordered ? "ol" : "ul";
          return (
            <Tag
              className={cn(
                "my-2 space-y-1.5 pl-6 text-[15px] leading-relaxed text-foreground",
                block.ordered ? "list-decimal" : "list-disc",
              )}
              key={key}
            >
              {block.items.map((item, itemIndex) => {
                const cleanItem = item.trim();
                return (
                  <li className="pl-1" key={`${key}-${itemIndex}`}>
                    {inlineNodes(cleanItem, `${key}-${itemIndex}`)}
                  </li>
                );
              })}
            </Tag>
          );
        }
        if (block.kind === "quote") {
          return (
            <blockquote
              className="border-l-2 border-primary/45 pl-3 italic text-muted-foreground"
              key={key}
            >
              {block.lines.map((line, lineIndex) => (
                <span key={`${key}-${lineIndex}`}>
                  {lineIndex > 0 ? <br /> : null}
                  {inlineNodes(line, `${key}-${lineIndex}`)}
                </span>
              ))}
            </blockquote>
          );
        }
        if (block.kind === "aligned") {
          return (
            <p
              className={cn(
                block.alignment === "center" && "text-center",
                block.alignment === "right" && "text-right",
              )}
              key={key}
            >
              {block.lines.map((line, lineIndex) => (
                <span key={`${key}-${lineIndex}`}>
                  {lineIndex > 0 ? <br /> : null}
                  {inlineNodes(line, `${key}-${lineIndex}`)}
                </span>
              ))}
            </p>
          );
        }
        return (
          <p key={key}>
            {block.lines.map((line, lineIndex) => (
              <span key={`${key}-${lineIndex}`}>
                {lineIndex > 0 ? <br /> : null}
                {inlineNodes(line, `${key}-${lineIndex}`)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

/** Sanitizes pasted HTML from external sources (Word, browsers, external mail) */
function sanitizePastedHtml(htmlString: string): string {
  if (typeof window === "undefined" || !htmlString.trim()) return "";
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");

  const allowedTags = new Set([
    "P", "BR", "H1", "H2", "H3", "STRONG", "B", "EM", "I", "U",
    "UL", "OL", "LI", "BLOCKQUOTE", "A", "SPAN"
  ]);

  const cleanNode = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      return doc.createTextNode(node.textContent || "");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const el = node as HTMLElement;
    const tagName = el.tagName.toUpperCase();

    if (tagName === "SCRIPT" || tagName === "STYLE" || tagName === "META" || tagName === "LINK") {
      return null;
    }

    if (!allowedTags.has(tagName)) {
      const fragment = doc.createDocumentFragment();
      for (const child of Array.from(el.childNodes)) {
        const cleanedChild = cleanNode(child);
        if (cleanedChild) fragment.appendChild(cleanedChild);
      }
      return fragment;
    }

    const newEl = doc.createElement(tagName.toLowerCase());

    if (tagName === "A" && el.getAttribute("href")) {
      const href = el.getAttribute("href") || "";
      if (isSafeHref(href)) {
        newEl.setAttribute("href", href);
        newEl.setAttribute("target", "_blank");
        newEl.setAttribute("rel", "noreferrer");
      }
    }

    for (const child of Array.from(el.childNodes)) {
      const cleanedChild = cleanNode(child);
      if (cleanedChild) newEl.appendChild(cleanedChild);
    }

    return newEl;
  };

  const container = doc.createElement("div");
  for (const child of Array.from(doc.body.childNodes)) {
    const cleaned = cleanNode(child);
    if (cleaned) container.appendChild(cleaned);
  }
  return container.innerHTML;
}

export function EmailRichTextComposer({
  id,
  value,
  disabled = false,
  onChange,
}: RichEmailComposerProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const isInternalChangeRef = useRef(false);
  const lastHtmlRef = useRef("");

  // Seed editor HTML on mount or when value changes externally (e.g. AI draft generation)
  useEffect(() => {
    if (isInternalChangeRef.current) {
      isInternalChangeRef.current = false;
      return;
    }
    if (!editorRef.current) return;

    const targetHtml = value.trim().startsWith("<") && value.includes(">")
      ? value
      : richEmailHtmlFromMarkdown(value);

    if (editorRef.current.innerHTML !== targetHtml) {
      editorRef.current.innerHTML = targetHtml || "<p><br></p>";
      lastHtmlRef.current = editorRef.current.innerHTML;
    }
  }, [value]);

  const emitChange = () => {
    if (!editorRef.current) return;
    const currentHtml = editorRef.current.innerHTML;
    if (currentHtml === lastHtmlRef.current) return;

    lastHtmlRef.current = currentHtml;
    isInternalChangeRef.current = true;
    onChange(currentHtml);
  };

  const handleInput = () => {
    emitChange();
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const htmlData = e.clipboardData.getData("text/html");
    const textData = e.clipboardData.getData("text/plain");

    if (htmlData) {
      const cleanHtml = sanitizePastedHtml(htmlData);
      if (typeof document !== "undefined" && typeof document.execCommand === "function") {
        document.execCommand("insertHTML", false, cleanHtml);
      }
    } else if (textData) {
      if (typeof document !== "undefined" && typeof document.execCommand === "function") {
        document.execCommand("insertText", false, textData);
      }
    }
    handleInput();
  };

  const preserveFocusAndExecute = (command: string, arg: string | undefined = undefined) => {
    if (!editorRef.current) return;
    editorRef.current.focus();
    if (typeof document !== "undefined" && typeof document.execCommand === "function") {
      // Deprecation Note: execCommand is used here for native cross-browser WYSIWYG formatting
      document.execCommand(command, false, arg);
    }
    emitChange();
  };

  const handleFormattingAction = (action: FormattingAction) => {
    switch (action) {
      case "bold":
        preserveFocusAndExecute("bold");
        return;
      case "italic":
        preserveFocusAndExecute("italic");
        return;
      case "underline":
        preserveFocusAndExecute("underline");
        return;
      case "heading":
        preserveFocusAndExecute("formatBlock", "<h2>");
        return;
      case "bullet-list":
        preserveFocusAndExecute("insertUnorderedList");
        return;
      case "numbered-list":
        preserveFocusAndExecute("insertOrderedList");
        return;
      case "quote":
        preserveFocusAndExecute("formatBlock", "blockquote");
        return;
      case "align-left":
        preserveFocusAndExecute("justifyLeft");
        return;
      case "align-center":
        preserveFocusAndExecute("justifyCenter");
        return;
      case "align-right":
        preserveFocusAndExecute("justifyRight");
        return;
    }
  };

  const addLink = () => {
    const href = linkUrl.trim();
    if (!isSafeHref(href)) return;
    preserveFocusAndExecute("createLink", href);
    setLinkUrl("");
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-background shadow-xs focus-within:border-primary/50 transition-colors">
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        id={id}
        data-testid="one-email-draft-message"
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        className="min-h-52 resize-y overflow-y-auto px-4 py-4 text-[15px] leading-relaxed outline-none focus-visible:outline-none sm:px-5 [&_p]:mb-4 [&_p:last-child]:mb-0 [&_ul]:mb-4 [&_ul]:pl-6 [&_ul]:list-disc [&_ol]:mb-4 [&_ol]:pl-6 [&_ol]:list-decimal [&_li]:mb-1 [&_blockquote]:mb-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold"
        onInput={handleInput}
        onBlur={handleInput}
        onPaste={handlePaste}
      />

      <div className="flex flex-wrap items-center gap-1 border-t border-border bg-muted/30 px-3 py-1.5">
        <div aria-label="Text formatting" className="flex items-center gap-0.5" role="toolbar">
          {FORMATTING_CONTROLS.map(({ label, action }) => {
            const Icon = formattingIcon(action);
            return (
              <Button
                aria-label={label}
                disabled={disabled}
                key={label}
                onMouseDown={(e) => {
                  // Prevent button click taking focus away from editor selection
                  e.preventDefault();
                }}
                onClick={() => handleFormattingAction(action)}
                size="icon"
                type="button"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground hover:bg-background hover:text-foreground"
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Input
            aria-label="Link URL"
            className="h-7 w-28 bg-background text-xs sm:w-40"
            disabled={disabled}
            onChange={(event) => setLinkUrl(event.target.value)}
            placeholder="https://…"
            value={linkUrl}
          />
          <Button
            aria-label="Add link"
            disabled={disabled || !isSafeHref(linkUrl.trim())}
            onMouseDown={(e) => e.preventDefault()}
            onClick={addLink}
            size="sm"
            type="button"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <Link2 className="h-3.5 w-3.5" />
            Link
          </Button>
        </div>
      </div>
    </div>
  );
}

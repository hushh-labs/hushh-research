"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Quote,
  Eye,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  PencilLine,
  Underline,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
const INLINE_TOKEN_RE = /(\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)|\*\*[^*]+\*\*|\*[^*]+\*|\+\+[^+]+\+\+)/g;

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

/** Normalizes model JSON that accidentally exposes escaped line breaks. */
export function normalizeRichEmailText(value: string): string {
  return value.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
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
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = ordered
          ? (lines[index] ?? "").match(/^\d+[.)]\s+(.+)$/)
          : (lines[index] ?? "").match(/^[-*]\s+(.+)$/);
        if (!candidate) break;
        items.push(candidate[1] ?? "");
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
      paragraph.push(lines[index] ?? "");
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
        return `<h${block.level}>${inlineHtml(block.text)}</h${block.level}>`;
      }
      if (block.kind === "list") {
        const tag = block.ordered ? "ol" : "ul";
        return `<${tag}>${block.items
          .map((item) => `<li>${inlineHtml(item)}</li>`)
          .join("")}</${tag}>`;
      }
      if (block.kind === "quote") {
        return `<blockquote>${block.lines.map(inlineHtml).join("<br>")}</blockquote>`;
      }
      if (block.kind === "aligned") {
        return `<p style="text-align:${block.alignment}">${block.lines
          .map(inlineHtml)
          .join("<br>")}</p>`;
      }
      return `<p>${block.lines.map(inlineHtml).join("<br>")}</p>`;
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
  return (
    <div className={cn("space-y-3 text-sm leading-6 text-foreground", className)}>
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
              className={cn("space-y-1 pl-5", block.ordered ? "list-decimal" : "list-disc")}
              key={key}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>
                  {inlineNodes(item, `${key}-${itemIndex}`)}
                </li>
              ))}
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

export function EmailRichTextComposer({
  id,
  value,
  disabled = false,
  showPreviewOnFirstContent = false,
  onChange,
}: RichEmailComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewedGeneratedContentRef = useRef(false);
  const [previewing, setPreviewing] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  useEffect(() => {
    if (
      showPreviewOnFirstContent &&
      !previewedGeneratedContentRef.current &&
      normalizeRichEmailText(value).trim()
    ) {
      previewedGeneratedContentRef.current = true;
      setPreviewing(true);
    }
  }, [showPreviewOnFirstContent, value]);

  const replaceSelection = (before: string, after = before, fallback = "text") => {
    const field = textareaRef.current;
    const start = field?.selectionStart ?? value.length;
    const end = field?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || fallback;
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  const prefixLines = (prefix: string, numbered = false) => {
    const field = textareaRef.current;
    const start = field?.selectionStart ?? 0;
    const end = field?.selectionEnd ?? value.length;
    const lineStart = value.lastIndexOf("\n", Math.max(start - 1, 0)) + 1;
    const lineEnd = value.indexOf("\n", end);
    const selected = value.slice(lineStart, lineEnd < 0 ? value.length : lineEnd);
    const nextLines = selected
      .split("\n")
      .map((line, index) => (line ? `${numbered ? `${index + 1}. ` : prefix}${line}` : line));
    onChange(`${value.slice(0, lineStart)}${nextLines.join("\n")}${lineEnd < 0 ? "" : value.slice(lineEnd)}`);
    requestAnimationFrame(() => field?.focus());
  };

  const wrapBlock = (open: string, close: string) => {
    const field = textareaRef.current;
    const start = field?.selectionStart ?? 0;
    const end = field?.selectionEnd ?? value.length;
    const lineStart = value.lastIndexOf("\n", Math.max(start - 1, 0)) + 1;
    const lineEnd = value.indexOf("\n", end);
    const selected = value.slice(lineStart, lineEnd < 0 ? value.length : lineEnd) || "Text";
    onChange(
      `${value.slice(0, lineStart)}${open}\n${selected}\n${close}${lineEnd < 0 ? "" : value.slice(lineEnd)}`,
    );
    requestAnimationFrame(() => field?.focus());
  };

  const addLink = () => {
    const href = linkUrl.trim();
    if (!isSafeHref(href)) return;
    replaceSelection("[", `](${href})`, "link text");
    setLinkUrl("");
  };

  const handleFormattingAction = (action: FormattingAction) => {
    switch (action) {
      case "bold":
        replaceSelection("**");
        return;
      case "italic":
        replaceSelection("*");
        return;
      case "underline":
        replaceSelection("++");
        return;
      case "heading":
        prefixLines("## ");
        return;
      case "bullet-list":
        prefixLines("- ");
        return;
      case "numbered-list":
        prefixLines("", true);
        return;
      case "quote":
        prefixLines("> ");
        return;
      case "align-left":
        wrapBlock(":::left", ":::");
        return;
      case "align-center":
        wrapBlock(":::center", ":::");
        return;
      case "align-right":
        wrapBlock(":::right", ":::");
    }
  };

  return (
    <div className="overflow-hidden rounded-[var(--app-radius-lg)] border border-border/80 bg-background shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/30 px-2.5 py-2">
        <div aria-label="Text formatting" className="flex min-w-0 items-center gap-0.5" role="toolbar">
          {FORMATTING_CONTROLS.map(({ label, action }) => {
            const Icon = formattingIcon(action);
            return (
              <Button
                aria-label={label}
                disabled={disabled || previewing}
                key={label}
                onClick={() => handleFormattingAction(action)}
                size="icon"
                type="button"
                variant="ghost"
                className="h-8 w-8 rounded-lg"
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            );
          })}
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {!previewing ? (
            <>
              <Input
                aria-label="Link URL"
                className="h-8 w-32 rounded-lg bg-background text-xs sm:w-44"
                disabled={disabled}
                onChange={(event) => setLinkUrl(event.target.value)}
                placeholder="https://…"
                value={linkUrl}
              />
              <Button
                aria-label="Add link"
                disabled={disabled || !isSafeHref(linkUrl.trim())}
                onClick={addLink}
                size="sm"
                type="button"
                variant="ghost"
                className="h-8 gap-1 rounded-lg px-2 text-xs"
              >
                <Link2 className="h-3.5 w-3.5" />
                Link
              </Button>
            </>
          ) : null}
          <Button
            aria-label={previewing ? "Edit message" : "Preview message"}
            onClick={() => setPreviewing((current) => !current)}
            size="sm"
            type="button"
            variant="ghost"
            className="h-8 gap-1 rounded-lg px-2 text-xs"
          >
            {previewing ? <PencilLine className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {previewing ? "Edit" : "Preview"}
          </Button>
        </div>
      </div>
      {previewing ? (
        <div
          className="min-h-52 bg-background px-4 py-5 sm:px-5"
          data-testid="one-email-rich-preview"
        >
          <EmailRichTextPreview value={value} />
        </div>
      ) : (
        <Textarea
          aria-label="Message"
          className="min-h-52 resize-y rounded-none border-0 bg-transparent px-4 py-4 text-[15px] leading-7 shadow-none focus-visible:ring-0 sm:px-5"
          data-testid="one-email-draft-message"
          disabled={disabled}
          id={id}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Write your message…"
          ref={textareaRef}
          value={value}
        />
      )}
      <p className="border-t border-border/60 bg-muted/[0.18] px-4 py-2 text-xs text-muted-foreground sm:px-5">
        Preview shows the rich email that recipients receive. Use Return for paragraphs and the toolbar for formatting.
      </p>
    </div>
  );
}

"use client";

import { createContext, useContext, useId, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

import { ChatMarkdownLink, useCopyConfirmation } from "@/components/agent/chat-markdown-link";
import { Check, Copy } from "@/components/icons";
import { chatUrlTransform, remarkChatPhoneLinks } from "@/lib/agent/chat-links";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";

type HastElement = NonNullable<ExtraProps["node"]>;

function hastText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = node as { type?: string; value?: unknown; children?: unknown[] };
  if (value.type === "text" && typeof value.value === "string") return value.value;
  return (value.children ?? []).map(hastText).join("");
}

function firstElement(node: HastElement | undefined, tagName?: string): HastElement | undefined {
  return node?.children.find(
    (child): child is HastElement =>
      child.type === "element" && (tagName === undefined || child.tagName === tagName),
  );
}

function hasProperty(node: HastElement | undefined, name: string): boolean {
  return node?.properties?.[name] !== undefined && node?.properties?.[name] !== null;
}

/* ── Code ─────────────────────────────────────────────────────────────── */

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  sh: "Shell",
  shell: "Shell",
  zsh: "Shell",
  console: "Terminal",
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JSX",
  py: "Python",
  python: "Python",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  md: "Markdown",
  markdown: "Markdown",
  swift: "Swift",
  kotlin: "Kotlin",
  go: "Go",
  rust: "Rust",
  java: "Java",
  csv: "CSV",
};

function languageOf(code: HastElement | undefined): string | null {
  const className = code?.properties?.className;
  const classes = Array.isArray(className) ? className.map(String) : [];
  const language = classes.find((name) => name.startsWith("language-"))?.slice("language-".length);
  if (!language) return null;
  return LANGUAGE_LABELS[language.toLowerCase()] ?? language;
}

/**
 * A fenced block: a header with the language and a copy action, then the code
 * in the platform monospace, scrolling sideways inside its own box so a long
 * line never widens the answer or the page. The header renders from the first
 * streamed line, so the block does not jump when the fence closes.
 */
function AgentCodeBlock({ node }: { node: HastElement | undefined }) {
  const code = firstElement(node, "code");
  const text = hastText(code ?? node).replace(/\n$/, "");
  const language = languageOf(code);
  const { copied, copy } = useCopyConfirmation(text);

  return (
    <div
      data-agent-code-block
      className="my-3 overflow-hidden rounded-xl bg-[color:var(--agent-md-well)] shadow-[inset_0_0_0_1px_var(--agent-md-rule)] first:mt-0 last:mb-0"
    >
      <div className="flex h-8 items-center justify-between px-1 shadow-[inset_0_-1px_0_var(--agent-md-rule)]">
        <span
          data-agent-code-language
          className="px-2 text-[12px] font-medium leading-4 text-[color:var(--agent-md-muted)]"
        >
          {language ?? "Code"}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? "Code copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          data-agent-copy-code
          className="relative grid size-8 cursor-pointer place-items-center rounded-lg text-[color:var(--agent-md-muted)] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
        >
          {copied ? (
            <Check aria-hidden className="size-4 text-[color:var(--app-success-deep)] dark:text-[color:var(--app-success-bright)]" />
          ) : (
            <Copy aria-hidden className="size-4" />
          )}
          <span aria-live="polite" className="sr-only">
            {copied ? "Code copied to clipboard" : ""}
          </span>
          <MaterialRipple variant="none" effect="glass" />
        </button>
      </div>
      <pre
        data-agent-code-scroll
        role="region"
        aria-label={language ? `${language} code` : "Code"}
        // Keyboard users can scroll a long line into view.
        tabIndex={0}
        className="m-0 overflow-x-auto p-3 text-[13px] leading-5 text-foreground [tab-size:2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent-ring)]"
      >
        {/* The font sits on <code>: preflight gives every code element the app's
            mono token, which is the product sans, and would undo it on <pre>. */}
        <code className="whitespace-pre font-[ui-monospace,SFMono-Regular,Menlo,Consolas,monospace] [font-variant-ligatures:none]">
          {text}
        </code>
      </pre>
    </div>
  );
}

/* ── Checkboxes in task lists ─────────────────────────────────────────── */

function TaskCheck({ checked }: { checked: boolean }) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      aria-disabled="true"
      aria-label={checked ? "Done" : "Not done"}
      data-agent-task-check
      className={cn(
        "mt-1 grid size-4 shrink-0 place-items-center rounded-[4px]",
        checked
          ? "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
          : "shadow-[inset_0_0_0_1.5px_var(--agent-md-muted)]",
      )}
    >
      {checked ? <Check aria-hidden className="size-3" weight="bold" /> : null}
    </span>
  );
}

/* ── Sources (GFM footnotes) ──────────────────────────────────────────── */

/**
 * Footnotes are the answer's sources. Inside that section the label reads
 * "Sources", each entry is one compact numbered row, and the "back to
 * reference" arrows are dropped: the numbered citation in the text already
 * links here, and a row of arrows is clutter.
 */
const SourcesLabel = createContext<string | null>(null);

function headingRenderer(level: 1 | 2 | 3 | 4) {
  // The answer's type scale tops out at 17px, below any page title.
  // Sizes and line boxes live in globals.css: the base layer locks h2-h6 to
  // the app title scale with !important, which no utility class can beat.
  const styles = {
    1: "mb-2 mt-4",
    2: "mb-2 mt-4",
    3: "mb-1 mt-4",
    4: "mb-1 mt-4 text-[color:var(--agent-md-muted)]",
  } as const;
  const TAGS = { 1: "h2", 2: "h3", 3: "h4", 4: "h5" } as const;
  const Tag = TAGS[level];
  function Heading({ children, id }: { children?: ReactNode; id?: string }) {
    const sources = useContext(SourcesLabel);
    if (sources && level === 2) {
      return (
        <h2 id={id} data-agent-sources-label className="mb-1 text-[color:var(--agent-md-muted)]">
          {children}
        </h2>
      );
    }
    return (
      <Tag dir="auto" className={cn("text-foreground", styles[level], "first:mt-0")}>
        {children}
      </Tag>
    );
  }
  return Heading;
}

function Paragraph({ children }: { children?: ReactNode }) {
  const sources = useContext(SourcesLabel);
  if (sources) return <span className="min-w-0">{children}</span>;
  return (
    <p dir="auto" className="my-3 first:mt-0 last:mb-0">
      {children}
    </p>
  );
}

function OrderedList({ children, start }: { children?: ReactNode; start?: number }) {
  const sources = useContext(SourcesLabel);
  if (sources) {
    return (
      <ol aria-labelledby={sources} className="agent-md-source-list m-0 list-none space-y-1 p-0">
        {children}
      </ol>
    );
  }
  return (
    <ol start={start} className="my-3 list-decimal space-y-1 pl-6 marker:tabular-nums marker:text-[color:var(--agent-md-muted)] first:mt-0 last:mb-0">
      {children}
    </ol>
  );
}

function ListItem({ children, className, id }: { children?: ReactNode; className?: string; id?: string }) {
  const sources = useContext(SourcesLabel);
  if (sources) {
    return (
      <li id={id} className="agent-md-source flex min-w-0 items-start gap-2 text-[14px] leading-6">
        {children}
      </li>
    );
  }
  const task = className?.includes("task-list-item");
  return (
    <li dir="auto" className={cn("pl-1", task && "flex list-none items-start gap-2 pl-0")}>
      {children}
    </li>
  );
}

/* ── Tables ───────────────────────────────────────────────────────────── */

// A cell this long wraps inside a readable column instead of stretching the
// table; anything shorter stays on one line and the table scrolls.
const LONG_CELL_CHARACTERS = 32;

function cellClassName(node: HastElement | undefined): string {
  return hastText(node).length > LONG_CELL_CHARACTERS ? "min-w-48 whitespace-normal" : "whitespace-nowrap";
}

// Module scope on purpose: a components map rebuilt per render gives every
// node a new component type on every streamed token, so React would remount
// the whole answer (and reset a code block's Copied state) as it streams.
const components: Components = {
  h1: headingRenderer(1),
  h2: headingRenderer(2),
  h3: headingRenderer(3),
  h4: headingRenderer(4),
  h5: headingRenderer(4),
  h6: headingRenderer(4),
  p: Paragraph,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  ul: ({ children, className: listClass }) => (
    <ul
      className={cn(
        "my-3 list-disc space-y-1 pl-6 marker:text-[color:var(--agent-md-muted)] first:mt-0 last:mb-0",
        listClass?.includes("contains-task-list") && "list-none pl-0",
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children, start }) => <OrderedList start={start}>{children}</OrderedList>,
  li: ({ children, className: itemClass, id }) => (
    <ListItem className={itemClass} id={id}>
      {children}
    </ListItem>
  ),
  input: ({ checked, type }) => (type === "checkbox" ? <TaskCheck checked={Boolean(checked)} /> : null),
  a: ({ children, href, node, id }) => {
    if (hasProperty(node, "dataFootnoteBackref")) return null;
    if (hasProperty(node, "dataFootnoteRef")) {
      const number = hastText(node);
      return (
        <ChatMarkdownLink
          href={href}
          id={id}
          aria-label={`Source ${number}`}
          className="agent-md-citation -my-1 inline-flex h-6 min-w-6 items-center justify-center p-0 align-middle no-underline"
        >
          <span className="grid h-4 min-w-4 place-items-center rounded-full bg-[color:var(--agent-md-well)] px-1 text-[11px] font-semibold leading-4 tabular-nums text-[color:var(--agent-md-link)] shadow-[inset_0_0_0_1px_var(--agent-md-rule)]">
            {number}
          </span>
        </ChatMarkdownLink>
      );
    }
    return (
      <ChatMarkdownLink href={href} id={id}>
        {children}
      </ChatMarkdownLink>
    );
  },
  sup: ({ children, node }) =>
    hasProperty(firstElement(node, "a"), "dataFootnoteRef") ? <>{children}</> : <sup>{children}</sup>,
  section: ({ children, node }) => {
    if (!hasProperty(node, "dataFootnotes")) return <section>{children}</section>;
    const labelId = String(firstElement(node, "h2")?.properties?.id ?? "agent-md-sources");
    return (
      <SourcesLabel.Provider value={labelId}>
        <section
          data-agent-sources
          className="mt-4 pt-3 shadow-[inset_0_1px_0_var(--agent-md-rule)] first:mt-0"
        >
          {children}
        </section>
      </SourcesLabel.Provider>
    );
  },
  // An image in an answer is never fetched: a remote image is a tracking
  // pixel, and model output can quote untrusted mail or pages. It is shown
  // as a link the person can choose to open.
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <ChatMarkdownLink href={src}>{alt?.trim() || "Image"}</ChatMarkdownLink>
    ) : (
      <span>{alt}</span>
    ),
  code: ({ children }) => (
    <code className="rounded-md bg-[color:var(--agent-md-well)] px-1 font-[ui-monospace,SFMono-Regular,Menlo,Consolas,monospace] text-[0.875em] [font-variant-ligatures:none] shadow-[inset_0_0_0_1px_var(--agent-md-rule)] [overflow-wrap:anywhere]">
      {children}
    </code>
  ),
  pre: ({ node }) => <AgentCodeBlock node={node} />,
  blockquote: ({ children }) => (
    <blockquote
      dir="auto"
      className="my-3 pl-3 text-[color:var(--agent-md-quote)] shadow-[inset_2px_0_0_var(--agent-md-rule-strong)] first:mt-0 last:mb-0"
    >
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 h-px border-0 bg-[color:var(--agent-md-rule)]" />,
  table: ({ children }) => (
    <div
      data-agent-table-scroll
      role="region"
      aria-label="Table"
      tabIndex={0}
      className="my-3 max-w-full overflow-x-auto rounded-xl border border-[color:var(--agent-md-rule)] first:mt-0 last:mb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
    >
      <table className="agent-md-table w-full border-separate border-spacing-0 text-left text-[14px] leading-5 tabular-nums">
        {children}
      </table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      dir="auto"
      style={style}
      className="whitespace-nowrap bg-[color:var(--agent-md-well)] px-3 py-2 font-semibold shadow-[inset_0_-1px_0_var(--agent-md-rule)]"
    >
      {children}
    </th>
  ),
  td: ({ children, style, node }) => (
    <td dir="auto" style={style} className={cn("px-3 py-2 align-top", cellClassName(node))}>
      {children}
    </td>
  ),
};

export function AgentMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  // Footnote ids are prefixed per answer, so answer two's [1] can never jump
  // to answer one's source list.
  const clobberPrefix = `am-${useId().replace(/[^a-zA-Z0-9]/g, "")}-`;


  return (
    <div className={cn("agent-markdown min-w-0 break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkChatPhoneLinks]}
        remarkRehypeOptions={{
          clobberPrefix,
          footnoteLabel: "Sources",
          footnoteLabelProperties: {},
        }}
        urlTransform={chatUrlTransform}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

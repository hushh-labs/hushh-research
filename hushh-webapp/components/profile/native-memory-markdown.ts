import { Fragment, isValidElement, type ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MAX_MARKDOWN_MEMORY_CHARS } from "@/lib/pkm/markdown-memory";

export type NativeMemoryMarkdownRun = { text: string; bold?: true; italic?: true; href?: string };
export type NativeMemoryMarkdownBlock = {
  kind: "heading" | "paragraph" | "list-item";
  text: string;
  level?: number;
  links: readonly { label: string; href: string }[];
  runs?: readonly NativeMemoryMarkdownRun[];
};

type ElementProps = { children?: ReactNode; href?: unknown; alt?: unknown; start?: unknown };

/** Parse through the same GFM/URL transform as SafeMarkdown. Only the bounded
 * headings, paragraphs and flat lists that the existing native row can render
 * are projected. Unsupported constructs return null for complete web handoff. */
export function nativeMemoryMarkdown(markdown: string): NativeMemoryMarkdownBlock[] | null {
  if (markdown.length > MAX_MARKDOWN_MEMORY_CHARS) return null;
  if (!markdown.trim()) {
    const text = "memory.md is empty. Add something you’d like One to remember.";
    return [{ kind: "paragraph", text, links: [], runs: [{ text }] }];
  }
  const root = Markdown({ children: markdown, remarkPlugins: [remarkGfm] });
  const blocks: NativeMemoryMarkdownBlock[] = [];
  let representable = true;

  const inline = (node: ReactNode, links: { label: string; href: string }[], runs: NativeMemoryMarkdownRun[], style: Omit<NativeMemoryMarkdownRun, "text"> = {}): string => {
    if (typeof node === "string" || typeof node === "number") {
      const text = String(node); if (text) runs.push({ text, ...style }); return text;
    }
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (Array.isArray(node)) return node.map(item => inline(item, links, runs, style)).join("");
    if (!isValidElement<ElementProps>(node)) { representable = false; return ""; }
    if (node.type === Fragment) return inline(node.props.children, links, runs, style);
    if (node.type === "br") { runs.push({ text: "\n", ...style }); return "\n"; }
    if (node.type === "strong" || node.type === "em") return inline(node.props.children, links, runs,
      { ...style, ...(node.type === "strong" ? { bold: true } : { italic: true }) });
    if (node.type === "a") {
      const href = typeof node.props.href === "string" ? defaultUrlTransform(node.props.href) : "";
      const label = inline(node.props.children, links, runs, { ...style, ...(href ? { href } : {}) });
      // SafeMarkdown renders unsafe/empty URLs as plain text.
      if (href && label) links.push({ label, href });
      return label;
    }
    // Code, tables, strikethrough, checkboxes and other rich constructs need
    // their complete existing web representation instead of lossy text.
    representable = false; return "";
  };

  const append = (kind: NativeMemoryMarkdownBlock["kind"], content: ReactNode, prefix = "", level?: number) => {
    const links: { label: string; href: string }[] = [];
    const runs: NativeMemoryMarkdownRun[] = prefix ? [{ text: prefix }] : [];
    const text = prefix + inline(content, links, runs);
    if (text.length > 4096 || runs.length > 128 || links.length > 50) representable = false;
    if (text) blocks.push({ kind, text, ...(level ? { level } : {}), links, runs });
  };
  const block = (node: ReactNode) => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (Array.isArray(node)) { node.forEach(block); return; }
    if (typeof node === "string") { if (node.trim()) representable = false; return; }
    if (!isValidElement<ElementProps>(node)) { representable = false; return; }
    if (node.type === Fragment) { block(node.props.children); return; }
    if (typeof node.type === "string" && /^h[1-6]$/.test(node.type)) { append("heading", node.props.children, "", Number(node.type[1])); return; }
    if (node.type === "p") { append("paragraph", node.props.children); return; }
    if (node.type === "ul" || node.type === "ol") {
      const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
      let index = typeof node.props.start === "number" ? node.props.start : 1;
      for (const item of children) {
        if (typeof item === "string" && !item.trim()) continue;
        if (!isValidElement<ElementProps>(item) || item.type !== "li") { representable = false; continue; }
        const content = item.props.children;
        // Loose or nested lists produce block children that need richer layout.
        append("list-item", content, node.type === "ol" ? `${index++}. ` : "• ");
      }
      return;
    }
    representable = false;
  };
  block(root);
  return representable && blocks.length <= 150 ? blocks : null;
}

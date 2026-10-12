"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** The same plain document is read by One and edited by its owner. */
export function SoulMemoryDocument({ markdown, preview = false }: { markdown: string; preview?: boolean }) {
  return <div aria-label={preview ? "Soul.md preview" : "Soul.md contents"} className="soul-memory-document">
    {markdown.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      img: ({ alt }) => <span>{alt || "Image"}</span>,
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      table: ({ children }) => <div data-swipe-views-horizontal-scroll className="overflow-x-auto"><table className="w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2">{children}</table></div>,
    }}>{markdown}</ReactMarkdown> : <p className="text-muted-foreground">Soul.md is empty. Add something you’d like One to remember.</p>}
  </div>;
}

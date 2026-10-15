"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Images never load (alt text only), links open isolated, and raw HTML stays
// text. react-markdown's default URL transform drops javascript: and other
// unsafe protocols, and no rehype-raw plugin is ever added here.
const COMPONENTS: Components = {
  img: ({ alt }) => <span>{alt || "Image"}</span>,
  a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  table: ({ children }) => <div data-swipe-views-horizontal-scroll className="overflow-x-auto"><table className="w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2">{children}</table></div>,
};
const GFM_PLUGINS = [remarkGfm];
const COMMONMARK_PLUGINS: typeof GFM_PLUGINS = [];

/**
 * Owner Markdown rendered without raw HTML, image loads or unsafe links.
 * `gfm={false}` renders plain CommonMark, so URL- or email-like text in
 * generated, escaped values never turns into a link.
 */
export const SafeMarkdown = memo(function SafeMarkdown({ markdown, gfm = true }: { markdown: string; gfm?: boolean }) {
  return <ReactMarkdown remarkPlugins={gfm ? GFM_PLUGINS : COMMONMARK_PLUGINS} components={COMPONENTS}>{markdown}</ReactMarkdown>;
});

"use client";

import { memo } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Which links may render. "external" (owner-authored memory.md): every safe
 * link opens isolated in a new tab. "internal" (generated previews): only an
 * app-relative link stays a link; any other address, including GFM-autolinked
 * emails and URLs that appear in owner values, renders as plain text.
 */
export type SafeMarkdownLinkPolicy = "external" | "internal";

/** "/one/profile/my-data" is app-relative; "//other.example" is protocol-relative and is not. */
function isAppRelative(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

// Images never load (alt text only) and raw HTML stays text, as no rehype-raw
// plugin is ever added here. react-markdown's default URL transform empties
// javascript:, data: and other unsafe hrefs before they reach these
// components, and an emptied href renders its text with no link at all.
const image: Components["img"] = ({ alt }) => <span>{alt || "Image"}</span>;
const table: Components["table"] = ({ children }) => (
  <div data-swipe-views-horizontal-scroll className="overflow-x-auto">
    <table className="w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2">{children}</table>
  </div>
);
const COMPONENTS: Record<SafeMarkdownLinkPolicy, Components> = {
  external: {
    img: image,
    table,
    a: ({ children, href }) =>
      href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <>{children}</>,
  },
  internal: {
    img: image,
    table,
    // Client-side navigation: a full page load would drop the in-memory vault
    // key and lock the owner out of the page they just opened.
    a: ({ children, href }) => (href && isAppRelative(href) ? <Link href={href}>{children}</Link> : <>{children}</>),
  },
};
const GFM_PLUGINS = [remarkGfm];
const COMMONMARK_PLUGINS: typeof GFM_PLUGINS = [];

/**
 * Owner Markdown rendered without raw HTML, image loads or unsafe links.
 * `gfm={false}` renders plain CommonMark, so URL- or email-like text in
 * generated, escaped values never turns into a link. `linkPolicy="internal"`
 * keeps GFM tables and lists while still turning every outside link into text.
 */
export const SafeMarkdown = memo(function SafeMarkdown({
  markdown,
  gfm = true,
  linkPolicy = "external",
}: {
  markdown: string;
  gfm?: boolean;
  linkPolicy?: SafeMarkdownLinkPolicy;
}) {
  return (
    <ReactMarkdown remarkPlugins={gfm ? GFM_PLUGINS : COMMONMARK_PLUGINS} components={COMPONENTS[linkPolicy]}>
      {markdown}
    </ReactMarkdown>
  );
});

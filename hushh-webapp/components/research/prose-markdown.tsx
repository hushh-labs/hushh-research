"use client";

/**
 * ProseMarkdown — the single long-form renderer for the Research & Papers
 * surface (PCHP specification + protocol blog). The webapp has no
 * @tailwindcss/typography plugin, so prose styling is expressed here with the
 * design-system tokens used elsewhere in app-ui. Bodies are authored as
 * GitHub-flavored Markdown strings (see lib/research/*), which keeps the spec
 * and blog easy to edit and easy for external contributors to fork.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export function ProseMarkdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "max-w-none text-[15px] leading-7 text-foreground/90",
        className
      )}
      data-slot="prose-markdown"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: ({ children }) => (
            <h2 className="mt-10 mb-3 scroll-mt-24 text-[22px] font-medium tracking-tight text-foreground first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-7 mb-2 text-[17px] font-medium tracking-tight text-foreground">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-5 mb-2 text-[15px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="my-3.5 leading-7 text-foreground/90">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="my-3.5 ml-5 list-disc space-y-1.5 marker:text-muted-foreground/60">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3.5 ml-5 list-decimal space-y-1.5 marker:text-muted-foreground/60">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-1 leading-7">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              className="font-medium text-sky-700 underline decoration-sky-400/40 underline-offset-2 transition-colors hover:decoration-sky-500 dark:text-sky-300"
              {...(href?.startsWith("http")
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {})}
            >
              {children}
            </a>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-5 border-l-2 border-sky-400/50 bg-sky-500/[0.04] py-1 pl-4 pr-3 text-foreground/80 italic dark:border-sky-400/40">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-8 border-border/60" />,
          code: ({ className: codeClass, children }) => {
            const isBlock = Boolean(codeClass);
            if (isBlock) {
              return (
                <code className="block text-[13px] leading-6">{children}</code>
              );
            }
            return (
              <code className="rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 font-mono text-[13px] text-foreground">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-5 overflow-x-auto rounded-[var(--app-card-radius-feature)] border border-border/60 bg-muted/40 p-4 font-mono text-[13px] leading-6 text-foreground/90">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-5 overflow-x-auto rounded-[var(--app-card-radius-feature)] border border-border/60">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-muted/50 text-left">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="border-b border-border/60 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border/40 px-3 py-2 align-top text-foreground/90">
              {children}
            </td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

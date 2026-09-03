"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ChatMarkdownLink } from "@/components/agent/chat-markdown-link";
import { cn } from "@/lib/utils";

/**
 * The one markdown renderer for agent answers.
 *
 * Extracted from `agent-chat-workspace.tsx` so Puppy One's transcript can use
 * the SAME renderer rather than a second one: an answer that arrives as
 * literal `**bold**` and unrendered code fences on one surface and as prose on
 * the other reads as two products, and the on-device tier is the half that
 * would look unfinished. It cannot live in the workspace and be imported from
 * there, because the workspace already imports the Puppy surface and the
 * cycle would close.
 */
export function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="agent-markdown min-w-0 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h2 className="mb-2 mt-1 text-base font-semibold leading-6 text-foreground">
              {children}
            </h2>
          ),
          h2: ({ children }) => (
            <h3 className="mb-2 mt-3 text-sm font-semibold leading-5 text-foreground">
              {children}
            </h3>
          ),
          h3: ({ children }) => (
            <h4 className="mb-1.5 mt-3 text-sm font-semibold leading-5 text-foreground">
              {children}
            </h4>
          ),
          h4: ({ children }) => (
            <h5 className="mb-1.5 mt-2 text-sm font-semibold leading-5 text-foreground">
              {children}
            </h5>
          ),
          p: ({ children }) => (
            <p className="my-2 first:mt-0 last:mb-0">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          a: ({ children, href }) => (
            <ChatMarkdownLink href={href}>{children}</ChatMarkdownLink>
          ),
          code: ({ children, className }) => {
            const inline = !className;
            if (inline) {
              return (
                <code className="rounded border border-border/70 bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                  {children}
                </code>
              );
            }
            return (
              <code className={cn("font-mono text-xs", className)}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto rounded-md border border-border/70 bg-muted/60 p-3 leading-5">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-primary/50 pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-md border border-border/70">
              <table className="min-w-full border-collapse text-left text-xs">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border/70 bg-muted/60 px-3 py-2 font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border/50 px-3 py-2 align-top last:border-b-0">
              {children}
            </td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

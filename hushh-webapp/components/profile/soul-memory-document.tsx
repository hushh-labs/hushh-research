"use client";

import { SafeMarkdown } from "@/components/profile/safe-markdown";

/** The same plain document is read by One and edited by its owner. */
export function SoulMemoryDocument({ markdown, preview = false }: { markdown: string; preview?: boolean }) {
  return <div aria-label={preview ? "memory.md preview" : "memory.md contents"} className="soul-memory-document">
    {markdown.trim() ? <SafeMarkdown markdown={markdown} linkPolicy="external" /> : <p className="text-muted-foreground">memory.md is empty. Add something you’d like One to remember.</p>}
  </div>;
}

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

export function ChatMarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const url = href ?? "";
  const copyable = /^https?:\/\//i.test(url);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(url);
    } catch {
      return;
    }
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  const anchor = (
    <a
      href={url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all font-medium text-primary underline decoration-primary/40 underline-offset-4 transition-colors hover:decoration-primary"
    >
      {children}
    </a>
  );

  if (!copyable) return anchor;

  return (
    <span className="inline-flex max-w-full items-baseline gap-1.5">
      {anchor}
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Link copied" : "Copy link"}
        title={copied ? "Copied" : "Copy link"}
        className="relative inline-flex h-5 w-5 shrink-0 translate-y-[3px] cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 after:absolute after:-inset-2.5 after:content-[''] hover:bg-muted hover:text-foreground active:scale-95"
      >
        {copied ? (
          <Check aria-hidden className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <Copy aria-hidden className="h-3.5 w-3.5" />
        )}
        <span aria-live="polite" className="sr-only">
          {copied ? "Link copied to clipboard" : ""}
        </span>
      </button>
    </span>
  );
}

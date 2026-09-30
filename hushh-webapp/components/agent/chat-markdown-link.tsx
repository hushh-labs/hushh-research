"use client";

import { Children, isValidElement, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy } from "@/components/icons";
import { classifyChatHref, formatBareUrlLabel, isBareChatLink } from "@/lib/agent/chat-links";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import { cn } from "@/lib/utils";

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

/** A copy action's two-second "Copied" state, shared by links and code. */
export function useCopyConfirmation(text: string) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await copyTextToClipboard(text);
    } catch {
      return;
    }
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return { copied, copy };
}

function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) return textOf(child.props.children);
      return "";
    })
    .join("");
}

function isPlainPrimaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Scroll an in-answer anchor (a citation or its source) into view. */
function revealAnchor(hash: string): boolean {
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return false;
  }
  const target = id ? document.getElementById(id) : null;
  if (!target) return false;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  const focusable = target.matches("a[href]") ? target : target.querySelector<HTMLElement>("a[href]");
  focusable?.focus({ preventScroll: true });
  return true;
}

export const CHAT_LINK_CLASSNAME =
  "agent-md-link rounded-sm py-1 font-medium text-[color:var(--agent-md-link)] underline decoration-[color:var(--agent-md-link-rule)] underline-offset-4 transition-colors hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]";

export function ChatMarkdownLink({
  href,
  children,
  className,
  "aria-label": ariaLabel,
  id,
}: {
  href?: string;
  children?: ReactNode;
  className?: string;
  "aria-label"?: string;
  id?: string;
}) {
  const router = useRouter();
  const url = href?.trim() ?? "";
  const kind = classifyChatHref(url);
  const bare = isBareChatLink(textOf(children), url);
  const { copied, copy } = useCopyConfirmation(url);

  if (kind === "unsafe") return <span>{children}</span>;

  const external = kind === "external";
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainPrimaryClick(event)) return;
    if (kind === "anchor") {
      if (revealAnchor(url)) event.preventDefault();
      return;
    }
    if (!external) return;
    const destination = new URL(url, window.location.href);
    event.preventDefault();
    // Same-origin links stay inside the app session; anything else goes
    // through the app's one external opener, which Capacitor hands to the OS.
    if (destination.origin === window.location.origin) {
      router.push(`${destination.pathname}${destination.search}${destination.hash}`);
      return;
    }
    openExternalUrl(destination.href);
  };

  if (!bare) {
    return (
      <a
        id={id}
        href={url}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        title={external ? url : undefined}
        aria-label={ariaLabel}
        onClick={handleClick}
        className={cn(CHAT_LINK_CLASSNAME, className)}
      >
        {children}
      </a>
    );
  }

  // A bare URL is noise as prose. Show where it goes, keep the whole URL on
  // hover (`title`) and one tap away from the clipboard.
  const label = formatBareUrlLabel(url);
  return (
    <span
      data-agent-link-chip
      className="agent-md-chip -my-1 inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-[color:var(--agent-md-well)] px-2 align-baseline shadow-[inset_0_0_0_1px_var(--agent-md-rule)]"
    >
      <a
        id={id}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={url}
        // Exactly the visible text, so the name is the same in every engine.
        aria-label={`${label.host}${label.path}`}
        onClick={handleClick}
        className="inline-flex h-6 min-w-0 items-center rounded-sm text-[14px] font-medium text-[color:var(--agent-md-link)] no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
      >
        <span className="truncate">
          {label.host}
          {label.path ? <span className="font-normal text-[color:var(--agent-md-muted)]">{label.path}</span> : null}
        </span>
      </a>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Link copied" : `Copy link to ${label.host}`}
        title={copied ? "Copied" : "Copy link"}
        data-agent-copy-link
        className="relative grid size-3.5 shrink-0 cursor-pointer place-items-center rounded-sm text-[color:var(--agent-md-muted)] transition-colors after:absolute after:-inset-[5px] after:content-[''] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
      >
        {copied ? (
          <Check aria-hidden className="size-3.5 text-[color:var(--app-success-deep)] dark:text-[color:var(--app-success-bright)]" />
        ) : (
          <Copy aria-hidden className="size-3.5" />
        )}
        <span aria-live="polite" className="sr-only">
          {copied ? "Link copied to clipboard" : ""}
        </span>
        <MaterialRipple variant="none" effect="glass" />
      </button>
    </span>
  );
}

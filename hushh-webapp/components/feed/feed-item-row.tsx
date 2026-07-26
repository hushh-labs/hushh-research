"use client";

import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

function timeAgo(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const deltaMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(deltaMs / (60 * 1000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

export function FeedItemRow({
  item,
  onOpen,
}: {
  item: FeedItem;
  onOpen: (item: FeedItem) => void;
}) {
  const presentation = presentFeedItem(item);

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      disabled={!presentation.href}
      className={cn(
        "relative flex w-full flex-col gap-1.5 overflow-hidden px-4 py-5 text-left transition-colors",
        "hover:bg-foreground/[0.035] active:bg-foreground/[0.06]",
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon icon={presentation.icon} size="xs" aria-hidden="true" />
        <span>{presentation.domainLabel}</span>
        <span aria-hidden="true">&middot;</span>
        <span className="normal-case tracking-normal">{timeAgo(item.created_at)}</span>
        {!item.read ? (
          <span
            aria-label="Unread"
            className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          />
        ) : null}
      </div>
      <p
        className={cn(
          "text-[17px] font-semibold leading-snug",
          item.read ? "text-foreground/70" : "text-foreground",
        )}
      >
        {presentation.label}
      </p>
      <p
        className={cn(
          "text-[14px] leading-relaxed",
          item.read ? "text-foreground/50" : "text-foreground/75",
        )}
      >
        {presentation.description}
      </p>
      <MaterialRipple variant="none" effect="fade" className="z-0" />
    </button>
  );
}

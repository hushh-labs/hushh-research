"use client";

import { ChevronRight } from "lucide-react";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import { formatFeedTimestamp } from "@/lib/feed/feed-timestamp";
import type { FeedItem } from "@/lib/services/feed-service";

/**
 * A single historical activity row. Feed history uses person identity first:
 * photos when the bounded feed payload carries one, then initials, then a
 * quiet domain glyph. It deliberately avoids the settings-row ripple/icon tile
 * treatment, which made every Location event look like the same blue control.
 */
export function FeedRow({
  item,
  onOpen,
  unread,
}: {
  item: FeedItem;
  onOpen: (item: FeedItem) => void;
  /**
   * Overrides `item.read` for styling only. The Feed marks itself read on open
   * but keeps those rows looking unread for the rest of the visit; without this
   * the page's live refresh would restyle them the moment the server agreed.
   */
  unread?: boolean;
}) {
  const presentation = presentFeedItem(item);
  const read = unread === undefined ? item.read : !unread;
  const timestamp = formatFeedTimestamp(item.created_at);
  const isInteractive = Boolean(presentation.href);
  const rowClassName = cn(
    "grid min-h-[68px] w-full grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 text-left outline-hidden",
    "transition-colors [-webkit-tap-highlight-color:transparent]",
    isInteractive &&
      "cursor-pointer hover:bg-foreground/[0.035] active:bg-foreground/[0.055] focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2",
    !read && "bg-[color:var(--app-accent-tint)]/45",
  );
  const body = (
    <>
      <FeedRowIdentity presentation={presentation} />
      <span className="min-w-0 space-y-0.5">
        <span
          className={cn(
            "block text-[17px] leading-[22px] text-[color:var(--app-label)] [overflow-wrap:anywhere]",
            read ? "font-normal" : "font-semibold",
          )}
        >
          {!read ? <span className="sr-only">Unread: </span> : null}
          {presentation.label}
        </span>
        {presentation.description ? (
          <span className="block text-[13px] font-normal leading-[18px] text-[color:var(--app-secondary-label)] [overflow-wrap:anywhere]">
            {presentation.description}
            {timestamp ? (
              <time
                dateTime={item.created_at}
                className="max-[360px]:inline min-[361px]:hidden"
              >
                {" "}
                {timestamp}
              </time>
            ) : null}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center justify-end gap-2 text-[13px] leading-[18px] text-[color:var(--app-tertiary-label)]">
        <span
          aria-hidden="true"
          data-slot="feed-unread-marker"
          data-state={read ? "read" : "unread"}
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            read ? "bg-transparent" : "bg-[color:var(--app-accent)]",
          )}
        />
        {timestamp ? (
          <time
            dateTime={item.created_at}
            className="tabular-nums max-[360px]:hidden"
          >
            {timestamp}
          </time>
        ) : null}
        {isInteractive ? (
          <ChevronRight
            aria-hidden
            className="h-4 w-4 text-[color:var(--app-tertiary-label)]"
          />
        ) : null}
      </span>
    </>
  );

  return isInteractive ? (
    <button
      type="button"
      className={rowClassName}
      onClick={() => onOpen(item)}
      data-testid="feed-row"
    >
      {body}
    </button>
  ) : (
    <div className={rowClassName} data-testid="feed-row">
      {body}
    </div>
  );
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? ""))
    .slice(0, 2)
    .toUpperCase();
}

function FeedRowIdentity({
  presentation,
}: {
  presentation: ReturnType<typeof presentFeedItem>;
}) {
  const person = presentation.person ?? null;
  const Icon = presentation.icon;

  if (person) {
    return (
      <Avatar
        className="h-10 w-10 bg-[color:var(--app-neutral-fill)] text-[13px] font-semibold text-[color:var(--app-secondary-label)]"
        aria-hidden
      >
        {person.photoUrl ? <AvatarImage src={person.photoUrl} alt="" /> : null}
        <AvatarFallback className="bg-[color:var(--app-neutral-fill)] text-[color:var(--app-secondary-label)]">
          {initials(person.displayName)}
        </AvatarFallback>
      </Avatar>
    );
  }

  return (
    <span
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-neutral-fill)] text-[color:var(--app-secondary-label)]"
      aria-hidden
    >
      <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
    </span>
  );
}

"use client";

import { SettingsRow } from "@/components/app-ui/settings-ui";
import { cn } from "@/lib/utils";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import { formatFeedTimestamp } from "@/lib/feed/feed-timestamp";
import type { FeedIconTone } from "@/lib/feed/use-feed-actionables";
import type { FeedItem, FeedSourceDomain } from "@/lib/services/feed-service";

const DOMAIN_TONE: Record<FeedSourceDomain, FeedIconTone> = {
  consent: "accent",
  location: "blue",
  kai: "accent",
  kyc: "purple",
  connected_systems: "gray",
  connections: "green",
};

/**
 * A single historical activity row, built on the canonical SettingsRow so the
 * feed shares the app's list vocabulary (icon well, title/description,
 * inset-hairline separators). Unread items carry an accent tint + dot and a
 * full-strength title; read items dim, mirroring Instagram's activity list.
 */
export function FeedRow({
  item,
  onOpen,
}: {
  item: FeedItem;
  onOpen: (item: FeedItem) => void;
}) {
  const presentation = presentFeedItem(item);
  const read = item.read;
  const tone = DOMAIN_TONE[item.source_domain] ?? "gray";

  return (
    <SettingsRow
      icon={presentation.icon}
      iconTone={tone}
      density="compact"
      className={cn(!read && "!bg-accent-surface/40 sm:!bg-accent-surface/25")}
      title={
        <span
          className={cn(
            "text-[15px] tracking-[-0.01em]",
            read
              ? "font-normal text-foreground/70"
              : "font-semibold text-foreground",
          )}
        >
          {presentation.label}
        </span>
      }
      description={
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 line-clamp-1">
            {presentation.description}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatFeedTimestamp(item.created_at)}
          </span>
        </span>
      }
      trailing={
        !read ? (
          <span
            aria-label="Unread"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          />
        ) : null
      }
      chevron={Boolean(presentation.href)}
      onClick={presentation.href ? () => onOpen(item) : undefined}
    />
  );
}

"use client";

import Link from "next/link";

import { SettingsRow } from "@/components/app-ui/settings-ui";
import { ConsentAgentIcon } from "@/components/icons/agents";
import { FeedRowMetadata, FeedRowTimestamp, FEED_INLINE_ROW_CLASSNAME } from "@/components/feed/feed-row-metadata";
import type { FeedDriveProgress } from "@/lib/feed/drive-request-progress";

export function FeedDriveProgressRow({ item }: { item: FeedDriveProgress }) {
  return (
    <SettingsRow
      asChild
      layout="settings"
      density="compact"
      icon={ConsentAgentIcon}
      iconTone="capability"
      title={<FeedRowMetadata title={item.title} description={item.description} indicator={
        <span aria-hidden="true" className={item.waiting
          ? "h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60"
          : "h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-pulse motion-reduce:animate-none"} />
      } />}
      textOverflow="truncate"
      className={FEED_INLINE_ROW_CLASSNAME}
      trailing={<FeedRowTimestamp timestamp={item.queuedAt ?? item.requestedAt} />}
      chevron
      testId={`feed-drive-progress-${item.id}`}
    >
      <Link href={item.href} prefetch={false} aria-label={`${item.title}. ${item.description}`} />
    </SettingsRow>
  );
}

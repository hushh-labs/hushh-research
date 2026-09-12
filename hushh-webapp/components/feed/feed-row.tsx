"use client";

import { SettingsRow } from "@/components/app-ui/settings-ui";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { cn } from "@/lib/utils";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import { FeedRowMetadata } from "./feed-row-metadata";
import type { FeedItem } from "@/lib/services/feed-service";

/** History and pending requests share the same contact-list geometry. */
export function FeedRow({
  item,
  onOpen,
  unread,
}: {
  item: FeedItem;
  onOpen: (item: FeedItem) => void;
  unread?: boolean;
}) {
  const presentation = presentFeedItem(item);
  const read = unread === undefined ? item.read : !unread;
  const person = presentation.person;
  const Icon = presentation.icon;

  return (
    <SettingsRow
      layout="person"
      testId="feed-row"
      leading={
        person ? (
          <ConnectionPersonAvatar
            label={person.displayName}
            photoUrl={person.photoUrl}
            size="list"
          />
        ) : (
          <span
            aria-hidden
            className="inline-flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <Icon className="size-[18px]" />
          </span>
        )
      }
      title={
        <span className={cn(read ? "font-normal" : "font-semibold")}>
          {!read ? <span className="sr-only">Unread: </span> : null}
          {presentation.label}
        </span>
      }
      description={
        <FeedRowMetadata
          description={presentation.description}
          timestamp={item.created_at}
        />
      }
      trailing={
        <span
          aria-hidden
          data-slot="feed-unread-marker"
          data-state={read ? "read" : "unread"}
          className={cn(
            "block size-1.5 rounded-full",
            read ? "bg-transparent" : "bg-accent",
          )}
        />
      }
      chevron={Boolean(presentation.href)}
      onClick={presentation.href ? () => onOpen(item) : undefined}
    />
  );
}

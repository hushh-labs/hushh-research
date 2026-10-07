"use client";

import { memo } from "react";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { cn } from "@/lib/utils";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import { FeedRowMetadata } from "./feed-row-metadata";
import type { FeedItem } from "@/lib/services/feed-service";

// Capability hues match the shared icon registry. Circle activity uses the
// trusted-circle green even when it is delivered through the Location domain.
const FEED_ICON_COLOR: Record<string, string> = {
  Consent: "#F97316",
  Location: "var(--app-accent)",
  Finance: "#10B981",
  KYC: "#2563EB",
  "Connected systems": "#0284C7",
  Connections: "#10B981",
  "Circle chat": "#10B981",
  Calendar: "#0284C7",
  Mail: "#E11D48",
  Messages: "#10B981",
  "Google Drive": "#6366F1",
};

/**
 * History and pending requests share the same contact-list geometry.
 *
 * Memoised on its props: the page re-renders on every poll and every visit
 * bookkeeping change, and without this each row re-presented its item and
 * rebuilt its subtree on a phone for no visible change. `onOpen` is a stable
 * callback from the page.
 */
export const FeedRow = memo(function FeedRow({
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
  const iconColor = item.event_type.startsWith("circle_") ||
    item.event_type.startsWith("location_circle_")
    ? "#10B981"
    : FEED_ICON_COLOR[presentation.domainLabel] ?? "#6366F1";

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
            data-slot="feed-domain-icon"
            className="inline-flex size-10 items-center justify-center"
          >
            <Icon className="size-7" color={iconColor} />
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
});

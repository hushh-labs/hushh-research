"use client";

import Link from "next/link";

import { SettingsRow } from "@/components/app-ui/settings-ui";
import { ConsentAgentIcon } from "@/components/icons/agents";
import { FeedRowMetadata } from "@/components/feed/feed-row-metadata";
import type { FeedDriveProgress } from "@/lib/feed/drive-request-progress";

export function FeedDriveProgressRow({ item }: { item: FeedDriveProgress }) {
  return (
    <SettingsRow
      asChild
      layout="person"
      icon={ConsentAgentIcon}
      iconTone="capability"
      title={item.title}
      description={
        <FeedRowMetadata
          description={
            <span className="inline-flex min-w-0 items-start gap-1.5">
              <span
                aria-hidden="true"
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-pulse motion-reduce:animate-none"
              />
              <span className="whitespace-normal [overflow-wrap:anywhere]">
                {item.description}
              </span>
            </span>
          }
          timestamp={item.requestedAt}
        />
      }
      chevron
      testId={`feed-drive-progress-${item.id}`}
    >
      <Link href={item.href} prefetch={false} aria-label={`${item.title}. ${item.description}`} />
    </SettingsRow>
  );
}

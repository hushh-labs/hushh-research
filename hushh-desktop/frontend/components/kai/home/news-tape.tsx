"use client";

import { ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import type { KaiHomeNewsItem } from "@/lib/services/api-service";
import { openExternalUrl } from "@/lib/utils/browser-navigation";

interface NewsTapeProps {
  rows: KaiHomeNewsItem[];
}

function formatPublished(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function NewsTape({ rows }: NewsTapeProps) {
  if (!rows.length) {
    return (
      <SettingsGroup>
        <div className="px-4 py-4 text-sm text-muted-foreground">
          No recent market headlines are available right now.
        </div>
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup>
      {rows.slice(0, 6).map((row, index) => (
        <SettingsRow
          key={`${row.symbol}-${index}-${row.url}`}
          title={row.title}
          description={
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="border-border/70 bg-background/80 text-[10px] font-semibold text-muted-foreground">
                  {row.symbol}
                </Badge>
                <span>{row.source_name}</span>
              </div>
              <p className="mt-1">{formatPublished(row.published_at)}</p>
            </>
          }
          trailing={<ExternalLink className="h-4 w-4 text-muted-foreground" />}
          chevron
          onClick={() => openExternalUrl(row.url)}
        />
      ))}
    </SettingsGroup>
  );
}

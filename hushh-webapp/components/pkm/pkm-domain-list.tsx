"use client";

import { FolderTree } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import type { DomainSummary } from "@/lib/services/personal-knowledge-model-service";

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function PkmDomainList({
  domains,
  selectedDomain,
  onSelectDomain,
}: {
  domains: DomainSummary[];
  selectedDomain: string | null;
  onSelectDomain: (domain: string) => void;
}) {
  if (!domains.length) {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderTree />
          </EmptyMedia>
          <EmptyTitle>No domains yet</EmptyTitle>
          <EmptyDescription>
            PKM domains will appear here once data has been stored in your
            Personal Knowledge Model.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-2">
      {domains.map((domain) => {
        const isActive = selectedDomain === domain.key;
        return (
          <button
            key={domain.key}
            type="button"
            className={`w-full rounded-[var(--radius-md)] border px-4 py-3 text-left transition ${
              isActive
                ? "border-primary/30 bg-primary/8 text-foreground dark:bg-primary/12"
                : "border-transparent bg-card shadow-[var(--app-card-shadow-standard)] hover:bg-muted/50"
            }`}
            onClick={() => onSelectDomain(domain.key)}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{domain.displayName}</p>
                <p className="text-xs text-muted-foreground">{domain.key}</p>
              </div>
              <Badge variant="secondary">{domain.attributeCount} attrs</Badge>
            </div>
            {domain.readableSummary ? (
              <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                {domain.readableSummary}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground/70">
              Updated {formatTimestamp(domain.lastUpdated)}
            </p>
          </button>
        );
      })}
    </div>
  );
}

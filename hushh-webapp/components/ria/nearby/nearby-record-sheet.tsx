"use client";

/**
 * One public-association record, opened.
 *
 * Everything shown here is public and sourced. There is deliberately no contact
 * detail, no address, and no exact position: the underlying API does not return
 * them, and this surface must never look like the kind of thing that would.
 */

import { ExternalLink, Star } from "lucide-react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import { AvatarBubble, StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import { EYEBROW, MUTED_TEXT, SUBCARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import {
  formatScore,
  type NearbyRecord,
} from "@/lib/services/nws-nearby-service";
import { cn } from "@/lib/utils";

function initialsOf(name: string | null): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function NearbyRecordSheet({
  record,
  open,
  onOpenChange,
  onShortlist,
  shortlisted,
  saving = false,
}: {
  record: NearbyRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShortlist: (record: NearbyRecord) => void;
  shortlisted: boolean;
  saving?: boolean;
}) {
  if (!record) return null;

  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={onOpenChange}
      leading={<AvatarBubble initials={initialsOf(record.displayName)} />}
      eyebrow={record.organization ?? undefined}
      title={record.displayName ?? "Public record"}
      description={record.headline ?? undefined}
      mobilePresentation="sheet"
      footer={
        <Button
          type="button"
          variant={shortlisted ? "none" : "blue-gradient"}
          effect="fill"
          size="lg"
          fullWidth
          disabled={saving}
          data-voice-control-id="ria_clients_nearby_shortlist"
          onClick={() => onShortlist(record)}
        >
          <Star
            className={cn("mr-2 h-4 w-4", shortlisted && "fill-current")}
            aria-hidden
          />
          {shortlisted ? "Shortlisted" : "Shortlist"}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {record.lane ? <StatusPill tone="neutral">{record.lane}</StatusPill> : null}
          {record.confidence.grade ? (
            <StatusPill tone={record.confidence.grade === "A" ? "ready" : "pending"}>
              Confidence {record.confidence.grade}
            </StatusPill>
          ) : null}
          <StatusPill tone="pending">Provisional</StatusPill>
          {record.revalidationRequired ? (
            <StatusPill tone="pending">Needs revalidation</StatusPill>
          ) : null}
        </div>

        <div className={cn(SUBCARD_SURFACE, "grid grid-cols-2 gap-3 p-4")}>
          <Metric label="Nearby rank" value={formatScore(record.nearbyRankScore)} />
          <Metric label="Overall NWS" value={formatScore(record.globalNws)} />
        </div>
        <p className={MUTED_TEXT}>
          NWS is public professional network strength. Not net worth.
        </p>

        {record.publicLocation.label ? (
          <Section label="Public association">
            <p className="type-footnote">{record.publicLocation.label}</p>
            {record.publicLocation.distanceBand ? (
              <p className={MUTED_TEXT}>{record.publicLocation.distanceBand}</p>
            ) : null}
            <p className={MUTED_TEXT}>
              Distance is to a public professional association, never a residence.
            </p>
          </Section>
        ) : null}

        {record.reasons.length > 0 ? (
          <Section label="Why this ranked">
            <ul className="flex flex-col gap-1.5">
              {record.reasons.map((reason) => (
                <li key={reason} className="type-footnote flex gap-2">
                  <span aria-hidden className={MUTED_TEXT}>
                    ·
                  </span>
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {record.warnings.length > 0 ? (
          <Section label="Caveats">
            <ul className="flex flex-col gap-1.5">
              {record.warnings.map((warning) => (
                <li key={warning} className="type-footnote">
                  {warning}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {record.tags.length > 0 ? (
          <Section label="Sectors">
            <div className="flex flex-wrap gap-1.5">
              {record.tags.map((tag) => (
                <StatusPill key={tag} tone="neutral">
                  {tag}
                </StatusPill>
              ))}
            </div>
          </Section>
        ) : null}

        {record.sources.length > 0 ? (
          <Section label="Public sources">
            <ul className="flex flex-col gap-2">
              {record.sources.map((source) => (
                <li key={`${source.url}-${source.title}`}>
                  {source.url ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="type-footnote inline-flex items-center gap-1.5 text-[color:var(--app-accent-fg)] underline-offset-4 hover:underline"
                    >
                      <span>{source.title || source.publisher || source.url}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                    </a>
                  ) : (
                    <span className="type-footnote">{source.title}</span>
                  )}
                  {source.publisher && source.title ? (
                    <span className={cn(MUTED_TEXT, "ml-1.5")}>
                      {source.publisher}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </div>
    </AdaptiveDetailSurface>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={EYEBROW}>{label}</span>
      <span className="type-title3 tabular-nums">{value}</span>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={EYEBROW}>{label}</span>
      {children}
    </div>
  );
}

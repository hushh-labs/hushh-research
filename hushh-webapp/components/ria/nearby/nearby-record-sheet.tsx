"use client";

/**
 * One public record, opened.
 *
 * Everything here is public and sourced. There is deliberately no contact
 * detail, no address, and no exact position — the API does not return them, and
 * this surface must never look like the kind of thing that would.
 */

import { ExternalLink, Star } from "lucide-react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { NearbyEvidencePanel } from "@/components/ria/nearby/nearby-evidence-panel";
import { NearbyScoreExplainer } from "@/components/ria/nearby/nearby-score-explainer";
import { Button } from "@/lib/morphy-ux/button";
import { AvatarBubble, StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import { EYEBROW, MUTED_TEXT, SUBCARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import {
  associationCategoryLabel,
  factTypeLabel,
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
  capitalAccessNote,
}: {
  record: NearbyRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShortlist: (record: NearbyRecord) => void;
  shortlisted: boolean;
  saving?: boolean;
  capitalAccessNote?: string | null;
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
          <Star className={cn("mr-2 h-4 w-4", shortlisted && "fill-current")} aria-hidden />
          {shortlisted ? "Shortlisted" : "Shortlist"}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className={cn(SUBCARD_SURFACE, "flex items-baseline gap-4 p-4")}>
          <span className="type-display tabular-nums">
            {formatScore(record.nearbyRankScore)}
          </span>
          <div className="min-w-0">
            <p className={MUTED_TEXT}>Network strength, not net worth.</p>
            <p className={MUTED_TEXT}>
              Overall {formatScore(record.globalNws)} · Confidence{" "}
              {record.confidence.grade ?? "—"}
            </p>
            {/* A nationally discovered record scores far below a reviewed one
                because most of the weighting has nothing to read, not because
                the person is lesser. The word "provisional" on its own does not
                carry that, so the regime says what it actually measured. */}
            {record.scoreKind === "PROFESSIONAL_NETWORK_PROVISIONAL" ? (
              <p className={MUTED_TEXT}>From public registry role and recency only.</p>
            ) : null}
          </div>
        </div>

        {record.publicLocation.label ? (
          <div className="flex flex-col gap-0.5">
            <p className="type-footnote">
              {record.associationContext ? (
                <span className="font-medium">
                  {associationCategoryLabel(record.associationContext.category)} ·{" "}
                </span>
              ) : null}
              {record.publicLocation.label}
              {record.publicLocation.distanceBand ? (
                <span className={MUTED_TEXT}> · {record.publicLocation.distanceBand}</span>
              ) : null}
            </p>
            {/* "Based here" alone reads as a claim about where someone lives.
                The release ships the definition that prevents that, so it is
                shown rather than summarised. */}
            {record.associationContext?.definition ? (
              <p className={MUTED_TEXT}>{record.associationContext.definition}</p>
            ) : null}
          </div>
        ) : null}

        {record.scoreBreakdown ? (
          <div className="flex flex-col gap-2">
            <span className={EYEBROW}>How this score is built</span>
            <NearbyScoreExplainer
              breakdown={record.scoreBreakdown}
              capitalAccessNote={capitalAccessNote}
            />
          </div>
        ) : record.reasons.length > 0 ? (
          // Older service revisions publish prose but no arithmetic. Show the
          // prose rather than nothing, and never both — they say the same thing.
          <div className="flex flex-col gap-1.5">
            <span className={EYEBROW}>Why this ranked</span>
            <ul className="flex flex-col gap-1">
              {record.reasons.map((reason) => (
                <li key={reason} className="type-footnote">
                  {reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {record.evidence ? (
          <NearbyEvidencePanel evidence={record.evidence} warnings={record.warnings} />
        ) : record.warnings.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {record.warnings.map((warning) => (
              <li key={warning} className={MUTED_TEXT}>
                {warning}
              </li>
            ))}
          </ul>
        ) : null}

        {record.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {record.tags.map((tag) => (
              <StatusPill key={tag} tone="neutral">
                {tag}
              </StatusPill>
            ))}
          </div>
        ) : null}

        {record.sources.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className={EYEBROW}>Sources</span>
            {record.sources.map((source) => (
              <div key={`${source.url}-${source.title}`} className="flex flex-col gap-0.5">
                <a
                  href={source.url ?? "#"}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="type-footnote inline-flex items-center gap-1.5 text-[color:var(--app-accent-fg)] underline-offset-4 hover:underline"
                >
                  <span>{source.title || source.publisher}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                </a>
                {source.factTypes.length > 0 ? (
                  <span className={MUTED_TEXT}>
                    {source.publisher ? `${source.publisher} · ` : ""}
                    Proves {source.factTypes.map(factTypeLabel).join(", ").toLowerCase()}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </AdaptiveDetailSurface>
  );
}

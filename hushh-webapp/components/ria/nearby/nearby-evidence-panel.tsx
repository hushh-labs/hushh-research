"use client";

/**
 * How well-sourced this record is — the diligence signal, stated once.
 *
 * The reviewed release attaches a "warning" to every record it publishes:
 * limited coverage on all sixty, single source family on fifty-five. Rendering
 * those as red errors would put an alarm on every profile and teach an advisor
 * to ignore all of them, including the one that matters. They are a property of
 * a careful first release, not a fault, so they read as evidence quality.
 *
 * The one distinction worth keeping loud is independence: two links from the
 * same organisation are not two confirmations, and that is the difference
 * between a claim to act on and one to check first.
 */

import { CheckCircle2, Info } from "lucide-react";

import { StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import { EYEBROW, MUTED_TEXT, SUBCARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import type { NearbyEvidence } from "@/lib/services/nws-nearby-service";
import { cn } from "@/lib/utils";

/** Flags the release raises. Anything unmapped falls back to its own wording. */
const FLAG_COPY: Record<string, string> = {
  SINGLE_SOURCE_FAMILY: "All citations come from one organisation",
  ROLE_REFRESH_REQUIRED: "Role claim is due a refresh",
};

function flagLabel(flag: string): string {
  return FLAG_COPY[flag] ?? flag.replace(/_/g, " ").toLowerCase();
}

export function NearbyEvidencePanel({
  evidence,
  warnings,
}: {
  evidence: NearbyEvidence;
  warnings: string[];
}) {
  const { citationCount, sourceFamilyCount, factCount, independentSourceFamilies } = evidence;
  const independent = independentSourceFamilies;

  // The flags already say what the warnings say, in fewer words. Show the
  // warnings only when the release raised no flag to explain itself.
  const notes = evidence.reviewFlags.length > 0 ? [] : warnings;

  return (
    <div className="flex flex-col gap-2">
      <span className={EYEBROW}>Evidence</span>

      <div className={cn(SUBCARD_SURFACE, "flex flex-col gap-2 p-3")}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {typeof factCount === "number" ? (
            <Stat value={factCount} label="reviewed facts" />
          ) : null}
          {typeof citationCount === "number" ? (
            <Stat value={citationCount} label={citationCount === 1 ? "citation" : "citations"} />
          ) : null}
          {typeof sourceFamilyCount === "number" ? (
            <Stat
              value={sourceFamilyCount}
              label={sourceFamilyCount === 1 ? "organisation" : "organisations"}
            />
          ) : null}
        </div>

        <div className="flex items-start gap-1.5">
          {independent ? (
            <CheckCircle2
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--app-accent-fg)]"
              aria-hidden
            />
          ) : (
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="type-footnote">
            {independent
              ? "Confirmed by independent organisations"
              : "Not yet confirmed by a second organisation"}
          </span>
        </div>
      </div>

      {evidence.reviewFlags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {evidence.reviewFlags.map((flag) => (
            <StatusPill key={flag} tone="pending">
              {flagLabel(flag)}
            </StatusPill>
          ))}
        </div>
      ) : null}

      {notes.map((note) => (
        <p key={note} className={MUTED_TEXT}>
          {note}
        </p>
      ))}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="type-headline tabular-nums">{value}</span>
      <span className={MUTED_TEXT}>{label}</span>
    </span>
  );
}

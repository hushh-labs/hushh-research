"use client";

import Link from "next/link";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";
import { ROUTES } from "@/lib/navigation/routes";
import {
  LIVE_MEMORY_BOUNDARY_COPY,
  LIVE_MIRROR_KINDS,
  LIVE_MIRROR_SOURCE_LABELS,
  type LiveMirrorClaim,
  type LiveMirrorConflict,
  type LiveMirrorKind,
  type LiveMirrorView,
} from "@/lib/pkm/live-mirror-contract";
import {
  compareLiveMirrorFacts,
  formatLiveMirrorValue,
  liveMirrorFactStateLabel,
  liveMirrorPreviewRows,
  liveMirrorSourceRoute,
  liveMirrorStatus,
  type LiveMirrorPreviewRow,
} from "@/lib/pkm/live-mirror-presentation";
import { useLiveMirrorView } from "@/lib/pkm/use-live-mirror-view";

const KINDS = new Set<string>(LIVE_MIRROR_KINDS);
const NEEDS_REVIEW = liveMirrorFactStateLabel("conflicted") ?? "Needs review";

/** The source a conflict's predicate names ("profile.name" is Profile's); null for an unknown prefix. */
function conflictKind(conflict: LiveMirrorConflict): LiveMirrorKind | null {
  const prefix = conflict.predicate.slice(0, conflict.predicate.indexOf("."));
  return KINDS.has(prefix) ? (prefix as LiveMirrorKind) : null;
}

/** Where a claim came from: "Memory" for the owner-authored chat memory, else the source's label. */
function claimLabel(claim: LiveMirrorClaim): string {
  if (claim.label.trim()) return claim.label;
  return claim.source === "soul" ? "Memory" : LIVE_MIRROR_SOURCE_LABELS[claim.source];
}

/** "Memory: Ankit · Profile: Ankit Kumar": every claim with its source, none chosen. */
function conflictClaims(conflict: LiveMirrorConflict): string {
  return conflict.claims
    .map((claim) => `${claimLabel(claim)}: ${claim.value === null ? "Not set"
      : formatLiveMirrorValue(conflict.predicate, claim.value, { revision: claim.revision ?? undefined })}`)
    .join(" · ");
}

/** Where "Fix at source" goes: the first conflict's source, else the first fact's in display order. */
function fixAtSourceKind(view: LiveMirrorView): LiveMirrorKind | null {
  for (const conflict of view.conflicts ?? []) {
    const kind = conflictKind(conflict);
    if (kind) return kind;
  }
  return [...view.facts].sort(compareLiveMirrorFacts)[0]?.kind ?? null;
}

function PreviewRow({ row }: { row: LiveMirrorPreviewRow }) {
  const badge = liveMirrorFactStateLabel(row.state);
  return (
    <SettingsRow
      title={row.title}
      description={row.description ?? undefined}
      trailing={badge ? <Badge variant="secondary">{badge}</Badge> : undefined}
      testId="live-mirror-fact"
    />
  );
}

/** Both claims, with their sources, for the owner to review. Nothing is chosen or overwritten. */
function ConflictRow({ conflict }: { conflict: LiveMirrorConflict }) {
  return (
    <SettingsRow
      title={conflict.label}
      description={conflictClaims(conflict)}
      trailing={<Badge variant="secondary">{NEEDS_REVIEW}</Badge>}
      testId="live-mirror-conflict"
    />
  );
}

/**
 * A compact, read-only preview of the one shared Live Mirror. Profile, the
 * private agent's profile sheet and the Memory workspace all read the same
 * owner- and vault-epoch-fenced view and format it through the same
 * presentation module, so a value, state or status reads the same on each and
 * a lock or account switch clears it everywhere. Locked shows only a status line.
 */
export function LiveMirrorPreview({
  onNavigate,
  showOpenMemory = true,
}: {
  /** Runs before a link navigates, so a sheet can close first. */
  onNavigate?: () => void;
  /** Off where the preview already sits inside Memory. */
  showOpenMemory?: boolean;
}) {
  const mirror = useLiveMirrorView();
  const locked = mirror.status === "locked";
  const view = mirror.status === "ready" ? mirror.view : null;
  const status = view ? liveMirrorStatus(view.overall, view) : liveMirrorStatus(locked ? "locked" : "loading");
  const conflicts = view?.conflicts ?? [];
  // A disputed profile value is shown once, as its conflict row with both
  // claims. Record rows keep their own "Needs review" state, since a conflict
  // names a predicate rather than one record.
  const disputed = new Set(conflicts.map((conflict) => conflict.predicate));
  const rows = view
    ? liveMirrorPreviewRows(view.facts.filter((fact) => fact.kind !== "profile" || !disputed.has(fact.predicate)))
    : [];
  // At most one extra action, and only once the source has a reachable authority surface.
  const fixKind = view ? fixAtSourceKind(view) : null;
  const fix = fixKind ? liveMirrorSourceRoute(fixKind) : null;

  return (
    <section aria-label="Live memory preview" className="min-w-0">
      <SettingsGroup
        embedded
        separatorInset
        title="Live memory"
        description={locked ? undefined : LIVE_MEMORY_BOUNDARY_COPY}
        titleAction={
          locked ? undefined : (
            <Link
              href={buildProfileRoute({ panel: "my-data" })}
              onClick={onNavigate}
              className="inline-flex min-h-11 items-center rounded-md px-1 text-xs font-medium text-[color:var(--app-accent-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              See all
            </Link>
          )
        }
        testId="live-mirror-preview"
      >
        <SettingsRow
          title={<span role="status">{status.headline}</span>}
          description={status.sub ?? undefined}
          testId="live-mirror-status"
        />
        {conflicts.map((conflict) => (
          <ConflictRow key={conflict.predicate} conflict={conflict} />
        ))}
        {rows.map((row) => (
          <PreviewRow key={row.key} row={row} />
        ))}
        {fix ? (
          <SettingsRow asChild chevron title="Fix at source" trailing={fix.label} testId="live-mirror-fix-at-source">
            <Link href={fix.href} onClick={onNavigate} />
          </SettingsRow>
        ) : null}
        {showOpenMemory && !locked ? (
          <SettingsRow asChild chevron title="Open Memory" testId="live-mirror-open-memory">
            <Link href={ROUTES.PKM} onClick={onNavigate} />
          </SettingsRow>
        ) : null}
      </SettingsGroup>
    </section>
  );
}

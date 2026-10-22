"use client";

import Link from "next/link";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";
import { ROUTES } from "@/lib/navigation/routes";
import {
  LIVE_MEMORY_BOUNDARY_COPY,
  LIVE_MIRROR_HIDDEN_PREDICATES,
  type LiveMirrorConflict,
} from "@/lib/pkm/live-mirror-contract";
import {
  liveMirrorClaimText,
  liveMirrorFactStateLabel,
  liveMirrorFixRoutes,
  liveMirrorPreviewRows,
  liveMirrorStatus,
  type LiveMirrorPreviewRow,
} from "@/lib/pkm/live-mirror-presentation";
import { useLiveMirrorView } from "@/lib/pkm/use-live-mirror-view";

const HIDDEN_PREDICATES = new Set<string>(LIVE_MIRROR_HIDDEN_PREDICATES);

/**
 * Every side of one disagreement, a line each, as the shared claim formatter
 * words it: "Profile: Ankit · Checked just now · Version 2". Profile and this
 * preview both list claims through it, so a side reads the same on each and
 * money keeps its own currency. Nothing is chosen.
 */
export function LiveMirrorClaimLines({ conflict, now }: { conflict: LiveMirrorConflict; now: string }) {
  return (
    <>
      {conflict.claims.map((claim, index) => {
        const { label, value, detail } = liveMirrorClaimText(claim, conflict.predicate, now);
        return (
          <span key={`${claim.source}:${index}`} className="block">
            {detail ? `${label}: ${value} · ${detail}` : `${label}: ${value}`}
          </span>
        );
      })}
    </>
  );
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

/** Every claim with its source, a line each, for the owner to review. Nothing is chosen or overwritten. */
function ConflictRow({ conflict, now }: { conflict: LiveMirrorConflict; now: string }) {
  return (
    <SettingsRow
      title={conflict.label}
      description={<LiveMirrorClaimLines conflict={conflict} now={now} />}
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
  // Other people's identifiers never render, not even inside a disagreement.
  const conflicts = (view?.conflicts ?? []).filter((conflict) => !HIDDEN_PREDICATES.has(conflict.predicate));
  // A disputed profile value is shown once, as its conflict row with every
  // claim. Record rows keep their own "Needs review" state, since a conflict
  // names a predicate rather than one record.
  const disputed = new Set(conflicts.map((conflict) => conflict.predicate));
  const rows = view
    ? liveMirrorPreviewRows(view.facts.filter((fact) => fact.kind !== "profile" || !disputed.has(fact.predicate)))
    : [];
  // Fix rows appear only beside a disagreement, one per screen that owns a
  // disputed source. memory.md gets none: Memory is already open or a tap away.
  const fixes = liveMirrorFixRoutes(conflicts, { includeMemory: false });

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
              className="ui-text-trailing-action inline-flex min-h-11 items-center rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        {view && conflicts.map((conflict) => (
          <ConflictRow key={conflict.predicate} conflict={conflict} now={view.evaluatedAt} />
        ))}
        {rows.map((row) => (
          <PreviewRow key={row.key} row={row} />
        ))}
        {fixes.map((route) => (
          <SettingsRow key={route.href} asChild chevron title={route.label} testId="live-mirror-fix-at-source">
            <Link href={route.href} onClick={onNavigate} />
          </SettingsRow>
        ))}
        {showOpenMemory && !locked ? (
          <SettingsRow asChild chevron title="Open Memory" testId="live-mirror-open-memory">
            <Link href={ROUTES.PKM} onClick={onNavigate} />
          </SettingsRow>
        ) : null}
      </SettingsGroup>
    </section>
  );
}

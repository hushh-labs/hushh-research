"use client";

import Link from "next/link";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";
import { ROUTES } from "@/lib/navigation/routes";
import { LIVE_MEMORY_BOUNDARY_COPY } from "@/lib/pkm/live-mirror-contract";
import {
  liveMirrorFactStateLabel,
  liveMirrorPreviewRows,
  liveMirrorStatus,
  type LiveMirrorPreviewRow,
} from "@/lib/pkm/live-mirror-presentation";
import { useLiveMirrorView } from "@/lib/pkm/use-live-mirror-view";

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
  const rows = view ? liveMirrorPreviewRows(view.facts) : [];

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
        {rows.map((row) => (
          <PreviewRow key={row.key} row={row} />
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

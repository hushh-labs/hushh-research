"use client";

import Link from "next/link";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "@/lib/format/relative-time";
import { buildProfileRoute } from "@/lib/navigation/profile-routes";
import { ROUTES } from "@/lib/navigation/routes";
import {
  LIVE_MEMORY_BOUNDARY_COPY,
  LIVE_MIRROR_HIDDEN_PREDICATES,
  LIVE_MIRROR_PRESENCE_ONLY_PREDICATES,
  LIVE_MIRROR_SOURCE_LABELS,
  type LiveMirrorFact,
  type LiveMirrorFactValue,
  type LiveMirrorOverall,
  type LiveMirrorView,
} from "@/lib/pkm/live-mirror-contract";
import { useLiveMirrorView } from "@/lib/pkm/use-live-mirror-view";

const STATUS: Record<LiveMirrorOverall, string> = {
  locked: "Unlock to see memory",
  loading: "Getting your memory",
  current: "Up to date",
  updating: "Updating",
  stale: "May be out of date",
  partial: "Some sources unavailable",
  conflict: "Needs your review",
  empty: "Nothing yet",
};

const BADGE: Partial<Record<LiveMirrorFact["state"], string>> = {
  stale: "May be old",
  unavailable: "Can't check now",
  conflicted: "Needs review",
};

const PROFILE_LABELS: Readonly<Record<string, string>> = {
  "profile.name": "Name",
  "profile.email": "Email",
};

const HIDDEN: ReadonlySet<string> = new Set<string>([
  ...LIVE_MIRROR_HIDDEN_PREDICATES,
  ...LIVE_MIRROR_PRESENCE_ONLY_PREDICATES,
]);
const MAX_FACTS = 3;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function recency(fact: LiveMirrorFact): number {
  const changed = Date.parse(fact.sourceUpdatedAt ?? fact.capturedAt);
  return Number.isFinite(changed) ? changed : 0;
}

/** Name, email, then the newest verified records. Deleted records never show. */
function previewFacts(view: LiveMirrorView): LiveMirrorFact[] {
  const visible = view.facts.filter((fact) => fact.state !== "deleted" && !HIDDEN.has(fact.predicate));
  const chosen = ["profile.name", "profile.email"].flatMap((predicate) => {
    const fact = visible.find((each) => each.predicate === predicate);
    return fact ? [fact] : [];
  });
  const newest = visible
    .filter((fact) => fact.state === "verified" && fact.kind !== "profile")
    .sort((left, right) => recency(right) - recency(left) || left.key.localeCompare(right.key));
  return [...chosen, ...newest].slice(0, MAX_FACTS);
}

function formatValue(value: LiveMirrorFactValue): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString();
  if (ISO_TIME.test(value) && Number.isFinite(Date.parse(value)))
    return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return value;
}

function FactRow({ fact }: { fact: LiveMirrorFact }) {
  const badge = BADGE[fact.state];
  // A disagreement has no selected value, so none is shown.
  const value = fact.state === "conflicted" || fact.value === null ? undefined : formatValue(fact.value);
  const title = PROFILE_LABELS[fact.predicate] ?? `${LIVE_MIRROR_SOURCE_LABELS[fact.kind]} · ${fact.label}`;
  return (
    <SettingsRow
      title={title}
      description={value}
      trailing={badge ? <Badge variant="secondary">{badge}</Badge> : undefined}
      testId="live-mirror-fact"
    />
  );
}

/**
 * A compact, read-only preview of the one shared Live Mirror. Profile, One's
 * profile sheet and the Memory workspace all read the same owner- and
 * vault-epoch-fenced view, so a lock or account switch clears it everywhere.
 * Locked shows only a status line.
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
  const overall: LiveMirrorOverall = view?.overall ?? (locked ? "locked" : "loading");
  const checkedAgo = view?.lastVerifiedAt
    ? formatRelativeTime(Date.parse(view.lastVerifiedAt), Date.parse(view.evaluatedAt))
    : "";
  const facts = view ? previewFacts(view) : [];

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
          title={<span role="status">{STATUS[overall]}</span>}
          description={checkedAgo ? `Checked ${checkedAgo}` : undefined}
          testId="live-mirror-status"
        />
        {facts.map((fact) => (
          <FactRow key={fact.key} fact={fact} />
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

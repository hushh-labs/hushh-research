"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BadgeCheck,
  BookOpen,
  Briefcase,
  ChevronRight,
  FileText,
  FlaskConical,
  Gauge,
  GitBranch,
  History,
  Landmark,
  Plane,
  Search,
  ShoppingBag,
  Sparkles,
  Wand2,
} from "lucide-react";

import { SectionHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { ApiService } from "@/lib/services/api-service";
import {
  PersonalKnowledgeModelService,
  type DomainSummary,
} from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import {
  addNoteEntity,
  archiveMatchingNoteEntity,
  buildArchivedNoteSummaryPatch,
  buildSageNoteSummaryPatch,
  hasMatchingNote,
} from "@/lib/sage/add-note-entity";
import { listResearchThreads, type ResearchThreadEntity } from "@/lib/sage/research-thread-entity";
import { HealthRadarCard, type HealthRadarAxis } from "@/components/sage/health-radar-card";
import { ROUTES, buildSageAskRoute } from "@/lib/navigation/routes";

const RESEARCH_DOMAIN = "research";

const DOMAIN_ICON: Record<string, typeof Landmark> = {
  financial: Landmark,
  professional: Briefcase,
  shopping: ShoppingBag,
  travel: Plane,
  kyc_connector: BadgeCheck,
};

type TextState = {
  loading: boolean;
  text: string | null;
};

type SuggestedFix = {
  noteText: string;
  fromDomain: string;
  fromDisplayName: string;
  targetDomain: string;
  targetDisplayName: string;
};

type FixState = "idle" | "fixing" | "fixed" | "error";

function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const days = Math.max(0, Math.round((Date.now() - then) / 86_400_000));
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/**
 * How much real, current substance actually lives in one PKM domain --
 * blends raw richness (attribute count) with recency (when it was last
 * updated), same "real signal, no invented score" rule as Research
 * Threads' Investigation Health. Both halves come straight off the
 * DomainSummary already loaded for this page.
 */
/** Attribute count at which a domain is considered maximally "rich" on the
 * radar. Log-scaled rather than linear so richness keeps discriminating
 * well past a handful of attributes -- a straight `count * 5` capped at
 * 100 saturated at just 20 attributes, which meant any reasonably active
 * account showed every domain pinned at 100% and the radar flattened into
 * an uninformative regular pentagon. */
const RICHNESS_SATURATION_ATTRIBUTE_COUNT = 200;

function computeDomainHealth(domain: DomainSummary): number {
  const richness = Math.min(
    100,
    Math.round(
      (Math.log2(domain.attributeCount + 1) / Math.log2(RICHNESS_SATURATION_ATTRIBUTE_COUNT + 1)) * 100,
    ),
  );
  const updatedAt = domain.readableUpdatedAt || domain.lastUpdated;
  const updatedTime = updatedAt ? new Date(updatedAt).getTime() : NaN;
  const days = Number.isFinite(updatedTime) ? Math.max(0, (Date.now() - updatedTime) / 86_400_000) : Infinity;
  const freshness = !Number.isFinite(days) ? 20 : days <= 7 ? 100 : days <= 30 ? 75 : days <= 90 ? 45 : 20;
  // Richness-weighted, not a straight average -- an even 50/50 blend means
  // freshness alone (pinned at 100 for anything touched in the last week)
  // puts a 50-point floor under every recently-touched domain no matter how
  // little is actually in it, which is what kept the radar looking "full"
  // even after richness itself stopped saturating instantly.
  return Math.round(richness * 0.7 + freshness * 0.3);
}

function computeKnowledgeHealth(domains: DomainSummary[]): { axes: HealthRadarAxis[]; overall: number } {
  const axes = domains.map((d) => ({ subject: d.displayName, value: computeDomainHealth(d) }));
  const overall = axes.length === 0 ? 0 : Math.round(axes.reduce((sum, a) => sum + a.value, 0) / axes.length);
  return { axes, overall };
}

/**
 * A real input right on the home tile -- but Sage never researches inline
 * here. Submitting navigates to the dedicated Ask Sage page with the query
 * carried over and auto-asked there (buildSageAskRoute's `autoAsk`), so the
 * actual research call and its answer only ever happen on that one page,
 * never duplicated between a home-tile version and the full page.
 */
function QuickAskBox() {
  const router = useRouter();
  const [query, setQuery] = useState("");

  function handleSubmit() {
    const trimmed = query.trim();
    if (!trimmed) return;
    router.push(buildSageAskRoute(trimmed, true));
  }

  return (
    <div className="flex items-center gap-1.5">
      <Textarea
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            handleSubmit();
          }
        }}
        placeholder="Ask a real question…"
        className="min-h-[2.25rem] flex-1 resize-none py-1.5 text-xs"
        rows={1}
      />
      <Button
        size="sm"
        onClick={handleSubmit}
        disabled={!query.trim()}
        className="bg-blue-600 text-white hover:bg-blue-700"
      >
        Ask
      </Button>
    </div>
  );
}

/**
 * Sage: a fresh reading of the same PKM store Kai/Nav/KYC have been writing
 * to all along -- one cross-domain "take" (a real connection across life
 * areas, never a per-domain recap) plus one clean sentence per domain.
 * Deliberately its own page/layout, not a reskin of the PKM explorer.
 *
 * The heavier interactive tools (Ask Sage, Research Threads, Citation
 * Lineage, Self-assessment, Notes) each live on their own dedicated page --
 * this page is a hub: a real "how much do I actually know about you"
 * radar, the cross-domain briefing, and a tile grid linking out.
 */
export function SagePanel() {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [briefing, setBriefing] = useState<TextState>({ loading: true, text: null });
  const [suggestedFix, setSuggestedFix] = useState<SuggestedFix | null>(null);
  const [fixState, setFixState] = useState<FixState>("idle");
  const [fixError, setFixError] = useState<string | null>(null);
  const [recap, setRecap] = useState<TextState>({ loading: false, text: null });
  const recapCheckedRef = useRef(false);
  const [latestThread, setLatestThread] = useState<ResearchThreadEntity | null>(null);

  const knowledgeHealth = useMemo(() => computeKnowledgeHealth(domains), [domains]);
  const totalAttributes = useMemo(() => domains.reduce((sum, d) => sum + d.attributeCount, 0), [domains]);
  // Freshness proxy for the header: the most recently touched domain, same
  // real timestamps already carried on DomainSummary -- never invented.
  const mostRecentUpdate = useMemo(() => {
    let latest: string | null = null;
    for (const domain of domains) {
      const updatedAt = domain.readableUpdatedAt || domain.lastUpdated;
      if (updatedAt && (!latest || updatedAt > latest)) latest = updatedAt;
    }
    return formatRelativeTime(latest);
  }, [domains]);

  // The Research Threads tile shows this thread's real synthesis instead of
  // static marketing copy -- a lightweight decrypt-only read (no LLM call),
  // same cost class as the domains fetch above, not the slow per-domain
  // summary calls below.
  useEffect(() => {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await PkmDomainResourceService.getStaleFirst({
          userId: user.uid,
          domain: RESEARCH_DOMAIN,
          vaultKey,
          vaultOwnerToken,
        });
        const threads = listResearchThreads(snapshot?.data || {}).filter((t) => t.status === "active");
        if (!cancelled) setLatestThread(threads[0] || null);
      } catch {
        if (!cancelled) setLatestThread(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, vaultKey, vaultOwnerToken]);

  async function refreshDomains() {
    if (!user?.uid || !vaultOwnerToken) return;
    const metadata = await PersonalKnowledgeModelService.getMetadata(user.uid, true, vaultOwnerToken);
    setDomains(metadata.domains);
  }

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!user?.uid || !vaultOwnerToken) {
        if (!cancelled) setLoadingDomains(false);
        return;
      }
      try {
        const metadata = await PersonalKnowledgeModelService.getMetadata(
          user.uid,
          false,
          vaultOwnerToken,
        );
        if (!cancelled) setDomains(metadata.domains);
      } catch {
        // Best-effort only -- leaves domains at its previous/empty value.
      } finally {
        if (!cancelled) setLoadingDomains(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [user, vaultOwnerToken]);

  useEffect(() => {
    if (!vaultOwnerToken || domains.length === 0) return;
    let cancelled = false;

    void (async () => {
      try {
        const response = await ApiService.summarizeSageBriefing({
          vaultOwnerToken,
          domains: domains.map((d) => ({
            domain: d.key,
            displayName: d.displayName,
            summary: d.summary,
            attributeCount: d.attributeCount,
            lastUpdated: d.readableUpdatedAt || d.lastUpdated,
          })),
        });
        const data = response.ok ? await response.json() : null;
        if (!cancelled) {
          setBriefing({ loading: false, text: data?.text || null });
          const fix = data?.suggested_fix;
          if (fix?.note_text && fix?.from_domain && fix?.target_domain) {
            setSuggestedFix({
              noteText: fix.note_text,
              fromDomain: fix.from_domain,
              fromDisplayName: fix.from_display_name || fix.from_domain,
              targetDomain: fix.target_domain,
              targetDisplayName: fix.target_display_name || fix.target_domain,
            });
          }
        }
      } catch {
        if (!cancelled) setBriefing({ loading: false, text: null });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [domains, vaultOwnerToken]);

  useEffect(() => {
    if (recapCheckedRef.current) return;
    if (!user?.uid || !vaultOwnerToken || domains.length === 0) return;
    recapCheckedRef.current = true;

    const storageKey = `sage_recap_snapshot_v1_${user.uid}`;
    type SnapshotEntry = { summary: Record<string, unknown>; updatedAt: string | null };
    let previousSnapshot: Record<string, SnapshotEntry> | null = null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      previousSnapshot = raw ? JSON.parse(raw) : null;
    } catch {
      previousSnapshot = null;
    }

    const currentSnapshot: Record<string, SnapshotEntry> = {};
    const changed: Array<{
      domain: string;
      displayName: string;
      previousSummary: Record<string, unknown>;
      currentSummary: Record<string, unknown>;
    }> = [];

    for (const domain of domains) {
      const updatedAt = domain.readableUpdatedAt || domain.lastUpdated || null;
      currentSnapshot[domain.key] = { summary: domain.summary, updatedAt };
      const previous = previousSnapshot?.[domain.key];
      if (previous && previous.updatedAt !== updatedAt) {
        changed.push({
          domain: domain.key,
          displayName: domain.displayName,
          previousSummary: previous.summary,
          currentSummary: domain.summary,
        });
      }
    }

    try {
      window.localStorage.setItem(storageKey, JSON.stringify(currentSnapshot));
    } catch {
      // Best-effort only -- losing the snapshot just means the next visit
      // won't have anything to diff against, not a functional break.
    }

    if (!previousSnapshot || changed.length === 0) return;

    setRecap({ loading: true, text: null });
    void (async () => {
      try {
        const response = await ApiService.getSageRecap({ vaultOwnerToken, domains: changed });
        const data = response.ok ? await response.json() : null;
        setRecap({ loading: false, text: data?.has_changes && data?.text ? data.text : null });
      } catch {
        setRecap({ loading: false, text: null });
      }
    })();
  }, [domains, user, vaultOwnerToken]);

  async function handleApplyFix() {
    if (!suggestedFix || !user?.uid || !vaultKey || !vaultOwnerToken) return;
    setFixState("fixing");
    setFixError(null);
    try {
      // Re-fetch live rather than trusting the `domains` snapshot -- readable_highlights
      // is replaced wholesale on write, not merged server-side, so a stale local
      // snapshot here could silently drop a newer highlight line added elsewhere.
      const freshDomains = await PersonalKnowledgeModelService.getMetadata(user.uid, true, vaultOwnerToken)
        .then((m) => m.domains)
        .catch(() => domains);

      // Check first: if a prior attempt already added this note to the
      // target domain (e.g. re-clicking after a partial success), don't
      // add a second duplicate -- just fall through to the source-side
      // archive below.
      const targetSnapshot = await PkmDomainResourceService.getStaleFirst({
        userId: user.uid,
        domain: suggestedFix.targetDomain,
        vaultKey,
        vaultOwnerToken,
      });
      const alreadyAdded = hasMatchingNote(targetSnapshot?.data || {}, suggestedFix.noteText);

      if (!alreadyAdded) {
        const targetDomain = freshDomains.find((d) => d.key === suggestedFix.targetDomain);
        const result = await PkmWriteCoordinator.saveMergedDomain({
          userId: user.uid,
          domain: suggestedFix.targetDomain,
          vaultKey,
          vaultOwnerToken,
          confirmation: { confirmedByUser: true, surface: "web", source: "sage_fix" },
          build: (context) => ({
            domainData: addNoteEntity(context.currentDomainData, suggestedFix.noteText, "sage_fix"),
            mergeDecision: { merge_mode: "replace_domain", target_domain: suggestedFix.targetDomain },
            summary: {
              source: "sage_fix",
              message_excerpt: suggestedFix.noteText.slice(0, 160),
              ...buildSageNoteSummaryPatch({
                displayName: suggestedFix.targetDisplayName,
                existingHighlights: targetDomain?.readableHighlights || [],
                noteText: suggestedFix.noteText,
              }),
            },
          }),
        });
        if (!result.success) {
          setFixState("error");
          setFixError(result.message || "Couldn't save that just now.");
          return;
        }
      }

      // Best-effort: archive the original entry in the source domain so the
      // fix reads as a real correction, not just a duplicate. Attempted
      // only after the target-side write already succeeded.
      try {
        const sourceSnapshot = await PkmDomainResourceService.getStaleFirst({
          userId: user.uid,
          domain: suggestedFix.fromDomain,
          vaultKey,
          vaultOwnerToken,
        });
        const archivedReason = `Moved to ${suggestedFix.targetDisplayName}`;
        const preview = archiveMatchingNoteEntity(sourceSnapshot?.data || {}, suggestedFix.noteText, archivedReason);
        if (preview.matched) {
          const sourceDomain = freshDomains.find((d) => d.key === suggestedFix.fromDomain);
          await PkmWriteCoordinator.saveMergedDomain({
            userId: user.uid,
            domain: suggestedFix.fromDomain,
            vaultKey,
            vaultOwnerToken,
            confirmation: { confirmedByUser: true, surface: "web", source: "sage_fix_archive" },
            build: (context) => {
              const archived = archiveMatchingNoteEntity(context.currentDomainData, suggestedFix.noteText, archivedReason);
              return {
                domainData: archived.domainData,
                mergeDecision: { merge_mode: "replace_domain", target_domain: suggestedFix.fromDomain },
                summary: {
                  source: "sage_fix_archive",
                  ...buildArchivedNoteSummaryPatch({
                    existingHighlights: sourceDomain?.readableHighlights || [],
                    noteText: suggestedFix.noteText,
                  }),
                },
              };
            },
          });
        }
      } catch {
        // Best-effort only -- the target-side write already succeeded;
        // don't surface an error for source-side cleanup.
      }

      setFixState("fixed");
      try {
        window.localStorage.removeItem(`sage_fix_seen_v1_${user.uid}`);
      } catch {
        // Best-effort only.
      }
      await refreshDomains();
    } catch (err) {
      setFixState("error");
      setFixError(err instanceof Error ? err.message : "Couldn't save that just now.");
    }
  }

  if (loadingDomains) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (domains.length === 0) {
    return (
      <div className="space-y-4">
        <Empty className="border-border/60 bg-muted/30">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-muted text-foreground">
              <Sparkles className="size-6" aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Sage is still getting to know you</EmptyTitle>
            <EmptyDescription>
              As Kai and the rest of One save real details about your life, Sage will start reading
              across them and surfacing what actually connects.
            </EmptyDescription>
          </EmptyHeader>
          <div className="mt-4 flex w-full max-w-xs flex-col gap-2">
            <Button asChild className="w-full bg-blue-600 text-white hover:bg-blue-700">
              <Link href={ROUTES.SAGE_ASK}>Ask Sage anything</Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link href={ROUTES.SAGE_NOTES}>Or add your first note</Link>
            </Button>
          </div>
        </Empty>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {recap.text ? (
        <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.04] p-4 dark:border-emerald-400/25 dark:bg-emerald-400/[0.04] sm:p-5">
          <span className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
            <History className="h-4 w-4" aria-hidden />
            What&apos;s new since your last visit
          </span>
          <p className="mt-2 text-[15px] leading-6 text-foreground">{recap.text}</p>
        </div>
      ) : null}

      <div className="relative overflow-hidden rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.05] p-5 dark:border-emerald-400/15 dark:bg-emerald-400/[0.04]">
        <span className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
            <Sparkles className="h-4 w-4" aria-hidden />
            Sage&apos;s take
          </span>
          {mostRecentUpdate ? (
            <span className="text-xs text-muted-foreground/70">Synced {mostRecentUpdate}</span>
          ) : null}
        </span>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <span className="flex items-baseline gap-1.5">
            <span className="text-[1.7rem] font-semibold leading-8 tabular-nums text-foreground">
              {domains.length}
            </span>
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70">
              area{domains.length === 1 ? "" : "s"} of your life
            </span>
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="text-[1.7rem] font-semibold leading-8 tabular-nums text-foreground">
              {totalAttributes}
            </span>
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70">
              tracked data points
            </span>
          </span>
        </div>
        <p className="mt-3 text-[15px] leading-6 text-foreground">
          {briefing.loading
            ? "Reading across everything Hushh knows about you…"
            : briefing.text || "Not enough saved detail yet to make a cross-domain observation."}
        </p>
      </div>

      {suggestedFix && fixState !== "fixed" ? (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-4 dark:border-amber-400/25 dark:bg-amber-400/[0.05] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-300">
              <Wand2 className="h-3.5 w-3.5" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">
                This looks filed under {suggestedFix.fromDisplayName}, not {suggestedFix.targetDisplayName}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">&ldquo;{suggestedFix.noteText}&rdquo;</p>
              {fixError ? <p className="mt-1 text-sm text-destructive">{fixError}</p> : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setSuggestedFix(null)}
              disabled={fixState === "fixing"}
            >
              Dismiss
            </Button>
            <Button
              size="sm"
              onClick={() => void handleApplyFix()}
              disabled={fixState === "fixing"}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {fixState === "fixing" ? "Adding…" : `Add to ${suggestedFix.targetDisplayName}`}
            </Button>
          </div>
        </div>
      ) : null}

      <div>
        <SectionHeader
          title="Sage's tools"
          icon={Sparkles}
          accent="neutral"
          testId="sage-tools-header"
        />

        <div className="mt-3 overflow-hidden rounded-2xl border border-border/60 bg-card/85">
          <Link
            href={ROUTES.SAGE_ASK}
            aria-label="Open Ask Sage"
            className="group relative isolate flex items-center gap-3 px-4 py-3.5"
          >
            <MaterialRipple variant="link" effect="glass" />
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-sky-500/12 text-sky-700 dark:bg-sky-400/20 dark:text-sky-200">
              <Search className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 text-[15px] font-medium text-foreground">Ask Sage</span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-muted-foreground/90 transition-transform group-hover:translate-x-0.5"
              aria-hidden
            />
          </Link>
          <div className="border-t border-border/60 px-4 py-3">
            <QuickAskBox />
          </div>
        </div>

        <SettingsGroup embedded className="mt-3" testId="sage-tools-list">
          <SettingsRow
            asChild
            icon={FlaskConical}
            iconTone="blue"
            title="Research threads"
            trailing={
              latestThread ? (
                <span className="text-sm text-muted-foreground">{latestThread.turns.length}</span>
              ) : null
            }
            chevron
            testId="sage-tool-threads"
          >
            <Link href={ROUTES.SAGE_THREADS} aria-label="Open Research threads" />
          </SettingsRow>
          <SettingsRow
            asChild
            icon={BookOpen}
            iconTone="blue"
            title="Notes"
            chevron
            testId="sage-tool-notes"
          >
            <Link href={ROUTES.SAGE_NOTES} aria-label="Open Notes" />
          </SettingsRow>
          <SettingsRow
            asChild
            icon={GitBranch}
            iconTone="blue"
            title="Citation lineage"
            chevron
            testId="sage-tool-citations"
          >
            <Link href={ROUTES.SAGE_CITATIONS} aria-label="Open Citation lineage" />
          </SettingsRow>
          <SettingsRow
            asChild
            icon={Sparkles}
            iconTone="blue"
            title="Everything Hushh knows"
            chevron
            testId="sage-tool-pkm"
          >
            <Link href={ROUTES.PKM} aria-label="Open Everything Hushh knows" />
          </SettingsRow>
        </SettingsGroup>
      </div>

      <div>
        <SectionHeader
          title="Your knowledge base"
          icon={Gauge}
          accent="neutral"
          testId="sage-knowledge-header"
        />
        <div className="mt-3 space-y-4">
          <div className="overflow-hidden rounded-2xl border border-border/60">
            <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-5 py-3">
              <Gauge className="h-4 w-4 text-foreground" aria-hidden />
              <span className="text-sm font-semibold text-foreground">Knowledge coverage</span>
            </div>
            <HealthRadarCard
              icon={Gauge}
              title="Knowledge coverage"
              axes={knowledgeHealth.axes}
              overall={knowledgeHealth.overall}
              scaleLabels={["Sparse", "Building", "Rich"]}
              bare
            />
            <Link
              href={ROUTES.SAGE_REVIEW}
              aria-label="Open Self-assessment"
              className="group flex items-center justify-between gap-2 border-t border-border/60 px-5 py-3"
            >
              <span className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-foreground" aria-hidden />
                <span className="text-sm font-semibold text-foreground">Self-assessment</span>
              </span>
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
                aria-hidden
              />
            </Link>
          </div>

          <SettingsGroup embedded separatorInset testId="sage-domain-list">
            {domains.map((domain) => {
              const Icon = DOMAIN_ICON[domain.key] || BookOpen;
              const relative = formatRelativeTime(domain.readableUpdatedAt || domain.lastUpdated);
              return (
                <SettingsRow
                  key={domain.key}
                  asChild
                  icon={Icon}
                  title={domain.displayName}
                  trailing={
                    <span className="text-sm text-muted-foreground">
                      {domain.attributeCount} saved{relative ? ` · ${relative}` : ""}
                    </span>
                  }
                  chevron
                  testId={`sage-domain-row-${domain.key}`}
                >
                  <Link href={ROUTES.PKM} aria-label={`Open ${domain.displayName}`} />
                </SettingsRow>
              );
            })}
          </SettingsGroup>
        </div>
      </div>
    </div>
  );
}

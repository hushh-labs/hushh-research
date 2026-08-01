"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
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
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";
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
const NOTE_PREFIX = /^saved from your note:\s*/i;

const DOMAIN_ICON: Record<string, typeof Landmark> = {
  financial: Landmark,
  professional: Briefcase,
  shopping: ShoppingBag,
  travel: Plane,
  kyc_connector: BadgeCheck,
};

/** Per-domain accent so the knowledge-base grid reads as distinct areas of
 * your life, not N copies of the same violet card. */
const DOMAIN_TONE_CLASS: Record<string, string> = {
  financial: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  professional: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  shopping: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  travel: "bg-teal-500/12 text-teal-700 dark:text-teal-300",
  kyc_connector: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
};
const DOMAIN_TONE_FALLBACK = "bg-violet-500/12 text-violet-700 dark:text-violet-300";

/** How many per-domain AI-summary calls fire at once -- see the effect below. */
const DOMAIN_TEXT_CONCURRENCY = 2;

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
 * A live "agent" tile -- top accent bar, ripple, hover lift, and room for a
 * real derived metric -- for the tools that carry actual state (a running
 * thread, a saved note). Mirrors the dashboard's AgentCard so Sage's home
 * page reads as alive rather than a static launcher grid. `children`
 * renders outside the Link so tiles that need their own nested links (Ask
 * Sage's prompt chips) never end up with an <a> inside an <a>.
 */
function SageAgentTile({
  icon: Icon,
  title,
  metric,
  metricLabel,
  insight,
  meta,
  href,
  loading = false,
  children,
}: {
  icon: typeof Landmark;
  title: string;
  metric?: string | null;
  metricLabel?: string;
  insight: string;
  meta?: string | null;
  href: string;
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="group relative isolate overflow-hidden rounded-xl border border-violet-500/24 bg-card/85 shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition-[border-color,box-shadow] duration-200 hover:border-violet-500/50 hover:shadow-[0_18px_36px_-24px_rgba(15,23,42,0.5)] dark:border-violet-400/20 dark:hover:border-violet-300/44">
      <span className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-violet-500 to-purple-400" aria-hidden />
      <Link href={href} aria-label={`Open ${title}`} className="relative isolate block p-4 sm:p-5">
        <MaterialRipple variant="link" effect="glass" className="rounded-xl" />
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/12 text-violet-700 dark:text-violet-300">
              <Icon className="h-4 w-4" aria-hidden />
            </span>
            <span className="truncate text-[15px] font-semibold leading-5 text-foreground">{title}</span>
          </span>
          <ArrowRight
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
            aria-hidden
          />
        </span>

        {metric ? (
          <span className="mt-2.5 flex items-baseline gap-1.5">
            <span className="text-[1.6rem] font-semibold leading-7 tabular-nums text-violet-700 dark:text-violet-300">
              {metric}
            </span>
            {metricLabel ? (
              <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70">
                {metricLabel}
              </span>
            ) : null}
          </span>
        ) : null}

        <p className={cn("line-clamp-3 text-sm leading-5 text-muted-foreground", metric ? "mt-2" : "mt-2.5")}>
          {loading ? "Reading…" : insight}
        </p>
      </Link>

      {children ? <div className="px-4 pb-1 sm:px-5">{children}</div> : null}

      {meta ? (
        <div className="flex items-center gap-1.5 px-4 pb-4 pt-2 text-xs text-muted-foreground/80 sm:px-5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" aria-hidden />
          <span className="truncate">{meta}</span>
        </div>
      ) : (
        <div className="pb-4 sm:pb-5" />
      )}
    </div>
  );
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
      <Button size="sm" onClick={handleSubmit} disabled={!query.trim()}>
        Ask
      </Button>
    </div>
  );
}

/** A quiet, compact launcher for tools with no per-visit state to surface --
 * kept small and low-emphasis on purpose so the three live tiles above (Ask
 * Sage, Research threads, Notes) read as the primary surface. */
function SageLinkTile({
  icon: Icon,
  title,
  description,
  href,
}: {
  icon: typeof Landmark;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      aria-label={`Open ${title}`}
      className="group relative isolate flex min-h-[6.75rem] flex-col overflow-hidden rounded-lg border border-border/60 bg-card/85 p-3.5 text-left shadow-sm transition-[border-color,box-shadow] duration-200 hover:border-violet-500/40 hover:shadow-[0_14px_32px_-28px_rgba(15,23,42,0.55)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:border-violet-400/35"
    >
      <MaterialRipple variant="link" effect="glass" className="rounded-lg" />
      <span className="flex items-start justify-between gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-700 dark:text-violet-300">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <ChevronRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
          aria-hidden
        />
      </span>
      <span className="mt-2 block text-sm font-semibold leading-5 text-foreground">{title}</span>
      <span className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">{description}</span>
    </Link>
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
 * radar, the cross-domain briefing, and a tile grid linking out. Keeping
 * every tool inlined here used to mean scrolling past three full
 * interactive panels just to see the domain summaries.
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
  const [domainText, setDomainText] = useState<Record<string, TextState>>({});
  const [suggestedPrompts, setSuggestedPrompts] = useState<string[]>([]);
  const [recap, setRecap] = useState<TextState>({ loading: false, text: null });
  const recapCheckedRef = useRef(false);
  const [latestThread, setLatestThread] = useState<ResearchThreadEntity | null>(null);

  const knowledgeHealth = useMemo(() => computeKnowledgeHealth(domains), [domains]);
  const totalAttributes = useMemo(() => domains.reduce((sum, d) => sum + d.attributeCount, 0), [domains]);

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

  // The Notes tile shows the most recent real note instead of static copy --
  // derived straight from the domain summaries already loaded, no extra
  // fetch (same raw-note extraction NotesArchivePanel uses).
  const latestNote = useMemo(() => {
    let best: { text: string; domainDisplayName: string; updatedAt: string } | null = null;
    for (const domain of domains) {
      const highlights = Array.isArray(domain.readableHighlights) ? domain.readableHighlights : [];
      const updatedAt = domain.readableUpdatedAt || domain.lastUpdated || "";
      for (const line of highlights) {
        if (!NOTE_PREFIX.test(line)) continue;
        const text = line.replace(NOTE_PREFIX, "").trim();
        if (!text) continue;
        if (!best || updatedAt > best.updatedAt) {
          best = { text, domainDisplayName: domain.displayName, updatedAt };
        }
      }
    }
    return best;
  }, [domains]);

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
          if (Array.isArray(data?.suggested_prompts)) {
            setSuggestedPrompts(data.suggested_prompts.filter((p: unknown) => typeof p === "string"));
          }
        }
      } catch {
        if (!cancelled) setBriefing({ loading: false, text: null });
      }
    })();

    // Each domain updates its own card the moment ITS call finishes, instead
    // of every card waiting on Promise.all across every domain -- previously
    // a fast domain's real summary sat invisible behind the single slowest
    // one. Also capped to DOMAIN_TEXT_CONCURRENCY at a time: backend logs
    // showed every one of these landing at ~10.1s in lockstep (the 8s LLM
    // timeout plus overhead) when all domains fired at once, which reads as
    // contention under concurrent load, not each call being independently
    // slow -- fewer in flight at once gives each a real shot at finishing
    // inside budget instead of timing out to its fallback together.
    void (async () => {
      for (let i = 0; i < domains.length; i += DOMAIN_TEXT_CONCURRENCY) {
        const batch = domains.slice(i, i + DOMAIN_TEXT_CONCURRENCY);
        await Promise.all(
          batch.map(async (d) => {
            try {
              const response = await ApiService.summarizePkmHighlight({
                vaultOwnerToken,
                domain: d.key,
                displayName: d.displayName,
                rawSummary: d.summary,
                highlights: d.readableHighlights || [],
                mode: "rich",
              });
              const data = response.ok ? await response.json() : null;
              if (!cancelled) {
                setDomainText((prev) => ({ ...prev, [d.key]: { loading: false, text: data?.text || null } }));
              }
            } catch {
              if (!cancelled) setDomainText((prev) => ({ ...prev, [d.key]: { loading: false, text: null } }));
            }
          }),
        );
        if (cancelled) return;
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
        const targetDomain = domains.find((d) => d.key === suggestedFix.targetDomain);
        const result = await PkmWriteCoordinator.saveMergedDomain({
          userId: user.uid,
          domain: suggestedFix.targetDomain,
          vaultKey,
          vaultOwnerToken,
          build: (context) => ({
            domainData: addNoteEntity(context.currentDomainData, suggestedFix.noteText, "sage_fix"),
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
      // fix reads as a real correction, not just a duplicate. Every other
      // Sage write this session is additive-only (deliberate, given this is
      // real production data with no automated tests) -- this is the one
      // exception, scoped to marking (never deleting) the exact matching
      // entity, attempted only after the Professional-side write already
      // succeeded.
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
          const sourceDomain = domains.find((d) => d.key === suggestedFix.fromDomain);
          await PkmWriteCoordinator.saveMergedDomain({
            userId: user.uid,
            domain: suggestedFix.fromDomain,
            vaultKey,
            vaultOwnerToken,
            build: (context) => {
              const archived = archiveMatchingNoteEntity(context.currentDomainData, suggestedFix.noteText, archivedReason);
              return {
                domainData: archived.domainData,
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
        // Best-effort only -- the Professional-side write already
        // succeeded; don't surface an error for source-side cleanup.
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
        <Empty className="border-violet-500/20 bg-violet-500/[0.03] dark:border-violet-400/20 dark:bg-violet-400/[0.03]">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-violet-500/10 text-violet-700 dark:text-violet-300">
              <Sparkles className="size-6" aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Sage is still getting to know you</EmptyTitle>
            <EmptyDescription>
              As Kai and the rest of One save real details about your life, Sage will start reading
              across them and surfacing what actually connects.
            </EmptyDescription>
          </EmptyHeader>
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

      <div className="relative overflow-hidden rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-500/[0.07] to-transparent p-5 dark:border-violet-400/20 dark:from-violet-400/[0.06]">
        <span className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-violet-500 to-purple-400" aria-hidden />
        <span className="flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-300">
          <Sparkles className="h-4 w-4" aria-hidden />
          Sage&apos;s take
        </span>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <span className="flex items-baseline gap-1.5">
            <span className="text-[1.7rem] font-semibold leading-8 tabular-nums text-violet-700 dark:text-violet-300">
              {domains.length}
            </span>
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70">
              area{domains.length === 1 ? "" : "s"} of your life
            </span>
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="text-[1.7rem] font-semibold leading-8 tabular-nums text-violet-700 dark:text-violet-300">
              {totalAttributes}
            </span>
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70">
              tracked data points
            </span>
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground/60">
          {/* This is every distinct field Sage has ever recorded (one portfolio
              holding alone is several), not a count of individual notes or
              memories -- worth being upfront about since it reads much larger
              than "things you'd call a fact." */}
          Every tracked field across your data, not individual notes -- a single portfolio holding or
          research answer counts as several.
        </p>
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
            <Button variant="ghost" size="sm" onClick={() => setSuggestedFix(null)} disabled={fixState === "fixing"}>
              Dismiss
            </Button>
            <Button size="sm" onClick={() => void handleApplyFix()} disabled={fixState === "fixing"}>
              {fixState === "fixing" ? "Adding…" : `Add to ${suggestedFix.targetDisplayName}`}
            </Button>
          </div>
        </div>
      ) : null}

      <div>
        <SectionHeader
          title="Sage's tools"
          description="Ask a question, keep a running investigation going, or trace real citations."
          icon={Sparkles}
          accent="violet"
          testId="sage-tools-header"
        />
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SageAgentTile
            icon={Search}
            title="Ask Sage"
            insight="A real question, researched live and personalized against what Sage knows about you."
            href={ROUTES.SAGE_ASK}
          >
            <div className="space-y-2">
              <QuickAskBox />
              {suggestedPrompts.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {suggestedPrompts.slice(0, 3).map((prompt) => (
                    <Link
                      key={prompt}
                      href={buildSageAskRoute(prompt)}
                      className="rounded-full border border-border/60 bg-card px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-violet-500/40 hover:text-foreground"
                    >
                      {prompt}
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
          </SageAgentTile>

          <SageAgentTile
            icon={FlaskConical}
            title="Research threads"
            metric={latestThread ? String(latestThread.turns.length) : null}
            metricLabel={latestThread ? `question${latestThread.turns.length === 1 ? "" : "s"} asked` : undefined}
            insight={
              latestThread?.synthesis?.summary ||
              "A real, ongoing investigation Sage keeps working on with you across visits -- not just one answer."
            }
            meta={
              latestThread
                ? `From "${latestThread.title}" · ${latestThread.tracedPapers.length} paper${
                    latestThread.tracedPapers.length === 1 ? "" : "s"
                  } traced`
                : null
            }
            href={ROUTES.SAGE_THREADS}
          />

          <SageAgentTile
            icon={BookOpen}
            title="Notes"
            insight={
              latestNote
                ? `"${latestNote.text}"`
                : "Add a note straight into any domain, or search every raw note you've ever given Kai."
            }
            meta={latestNote ? `Latest note · ${latestNote.domainDisplayName}` : null}
            href={ROUTES.SAGE_NOTES}
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <SageLinkTile
            icon={FileText}
            title="Self-assessment"
            description="A structured draft from your real accumulated history."
            href={ROUTES.SAGE_REVIEW}
          />

          <SageLinkTile
            icon={GitBranch}
            title="Trace a paper's citations"
            description="See what a real paper builds on and what builds on it."
            href={ROUTES.SAGE_CITATIONS}
          />

          <SageLinkTile
            icon={Sparkles}
            title="Everything Hushh knows"
            description="Every saved detail, across every domain."
            href={ROUTES.PKM}
          />
        </div>
      </div>

      <div>
        <SectionHeader
          title="Your knowledge base"
          description="How much Sage actually knows across every part of your life."
          icon={Gauge}
          accent="violet"
          testId="sage-knowledge-header"
        />
        <div className="mt-3 space-y-4">
          <HealthRadarCard
            icon={Gauge}
            title="Knowledge coverage"
            axes={knowledgeHealth.axes}
            overall={knowledgeHealth.overall}
            scaleLabels={["Sparse", "Building", "Rich"]}
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {domains.map((domain) => {
              const Icon = DOMAIN_ICON[domain.key] || BookOpen;
              const state = domainText[domain.key];
              const relative = formatRelativeTime(domain.readableUpdatedAt || domain.lastUpdated);
              return (
                <div
                  key={domain.key}
                  className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card/85 p-4 shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition-shadow duration-200 hover:shadow-[0_14px_32px_-28px_rgba(15,23,42,0.55)]"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                        DOMAIN_TONE_CLASS[domain.key] || DOMAIN_TONE_FALLBACK,
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="text-[15px] font-semibold text-foreground">{domain.displayName}</span>
                  </span>
                  <p className="line-clamp-6 text-sm leading-5 text-muted-foreground">
                    {/* Real fallback shown immediately, upgraded in place once
                        Sage's AI summary lands -- no blocking "Reading..." state. */}
                    {state?.text || `${domain.attributeCount} saved details.`}
                  </p>
                  {relative ? (
                    <span className="text-xs text-muted-foreground/70">Updated {relative}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

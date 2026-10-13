"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpFromLine,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  GitBranch,
  Quote,
  Search,
  Sparkles,
  Tag,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { ApiService } from "@/lib/services/api-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { addNoteEntity, buildSageNoteSummaryPatch } from "@/lib/sage/add-note-entity";
import {
  addTracedPaperToThread,
  buildResearchThreadsSummaryPatch,
  listResearchThreads,
} from "@/lib/sage/research-thread-entity";
import { PersonalKnowledgeModelService, type DomainSummary } from "@/lib/services/personal-knowledge-model-service";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

const RESEARCH_DOMAIN = "research";

type Paper = {
  id: string;
  title: string;
  year: number | null;
  authors: string[];
  citedByCount: number;
  topic: string | null;
};

type Lineage = {
  paper: Paper;
  references: Paper[];
  citedBy: Paper[];
};

function parsePaper(raw: unknown): Paper {
  const r = (raw || {}) as Record<string, unknown>;
  return {
    id: String(r.id || ""),
    title: String(r.title || "Untitled"),
    year: typeof r.year === "number" ? r.year : null,
    authors: Array.isArray(r.authors) ? r.authors.map(String) : [],
    citedByCount: typeof r.cited_by_count === "number" ? r.cited_by_count : 0,
    topic: typeof r.topic === "string" && r.topic.trim() ? r.topic.trim() : null,
  };
}

function authorLine(authors: string[]): string {
  if (authors.length === 0) return "";
  if (authors.length <= 2) return authors.join(" & ");
  return `${authors[0]} et al.`;
}

function formatCount(count: number): string {
  return count.toLocaleString();
}

const EXAMPLE_QUERIES = ["Attention Is All You Need", "AlphaFold protein structure", "CRISPR-Cas9"];

/** A citation-count pill, reused everywhere a paper's weight needs to read at a glance. */
function CitationChip({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300">
      <Quote className="h-2.5 w-2.5" aria-hidden />
      {formatCount(count)}
    </span>
  );
}

/**
 * A field/topic pill from OpenAlex's own classifier -- real structured
 * data (primary_topic), not an LLM guess, so it's styled as a plain
 * outline chip to visually read as "informational" next to the filled
 * (and AI-synthesized) chips around it.
 */
function TopicChip({ topic }: { topic: string | null }) {
  if (!topic) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
      <Tag className="h-2.5 w-2.5" aria-hidden />
      {topic}
    </span>
  );
}

/** A thin proportional bar showing how a paper's citation count ranks against the rest of its list. */
function WeightBar({ count, max }: { count: number; max: number }) {
  const pct = max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0;
  return (
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-violet-500/10">
      <div className="h-full rounded-full bg-violet-500/50" style={{ width: `${pct}%` }} />
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  label,
  count,
  sub,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  sub: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-base font-semibold text-foreground">
        <Icon className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
        {label}
        {count > 0 ? <span className="text-sm font-normal text-muted-foreground">({count})</span> : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{sub}</p>
    </div>
  );
}

/** How many levels deep a node can expand in place before the only option left is re-rooting the whole tree. */
const MAX_EXPAND_DEPTH = 2;

/**
 * One paper in the lineage spine. Expands in place to reveal its own
 * references (if it's on the "builds on" side) or its own citing works
 * (if it's on the "built on by" side) -- nested indefinitely deeper in the
 * SAME direction it was found in, so the tree never doubles back on
 * itself. Bounded by MAX_EXPAND_DEPTH; past that, "Trace from here" is the
 * only way further -- it re-roots the whole panel on this paper instead.
 */
function LineageNode({
  paper,
  direction,
  depth,
  rank,
  siblingMax,
  vaultOwnerToken,
  onRetrace,
}: {
  paper: Paper;
  direction: "back" | "forward";
  depth: number;
  rank: number;
  siblingMax: number;
  vaultOwnerToken: string | null;
  onRetrace: (paper: Paper) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [children, setChildren] = useState<Paper[] | null>(null);

  async function toggleExpand() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (children !== null || !vaultOwnerToken || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await ApiService.getSagePaperLineage({ vaultOwnerToken, workId: paper.id });
      if (!response.ok) throw new Error("Couldn't load this paper's lineage.");
      const data = await response.json();
      const raw = direction === "back" ? data.references : data.cited_by;
      const list: Paper[] = Array.isArray(raw) ? raw.map(parsePaper) : [];
      setChildren(direction === "back" ? list.slice().sort((a, b) => b.citedByCount - a.citedByCount) : list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load this paper's lineage.");
    } finally {
      setLoading(false);
    }
  }

  const canExpandInPlace = depth < MAX_EXPAND_DEPTH;
  const childMax = children && children.length > 0 ? Math.max(1, ...children.map((p) => p.citedByCount)) : 1;

  return (
    <div className="relative">
      <span
        className="absolute -left-[1.6rem] top-4 h-2 w-2 rounded-full bg-violet-500/60"
        aria-hidden
      />
      <div className="flex w-full items-start gap-2 rounded-lg border border-border/50 bg-background/60 p-3.5">
        <span className="mt-0.5 shrink-0 text-xs font-medium text-muted-foreground/70">#{rank}</span>
        <div className="min-w-0 flex-1 text-left">
          <p className="text-base leading-snug text-foreground">{paper.title}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            {[paper.year, authorLine(paper.authors)].filter(Boolean).join(" · ")}
            <CitationChip count={paper.citedByCount} />
            <TopicChip topic={paper.topic} />
          </p>
          <WeightBar count={paper.citedByCount} max={siblingMax} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canExpandInPlace ? (
            <button
              type="button"
              onClick={() => void toggleExpand()}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-violet-500/10 hover:text-foreground"
              aria-label={expanded ? "Collapse" : "Expand"}
              aria-expanded={expanded}
            >
              <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onRetrace(paper)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-violet-500/10 hover:text-foreground"
            aria-label="Trace from here"
            title="Trace from here"
          >
            <ArrowUpRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="relative ml-3 mt-2.5 space-y-2.5 border-l-2 border-violet-500/15 pl-6">
          {loading ? <Skeleton className="h-16 w-full" /> : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {!loading && !error && children && children.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {direction === "back" ? "No further references found." : "Nothing else cites this yet."}
            </p>
          ) : null}
          {!loading && !error && children
            ? children.map((child, index) => (
                <LineageNode
                  key={child.id}
                  paper={child}
                  direction={direction}
                  depth={depth + 1}
                  rank={index + 1}
                  siblingMax={childMax}
                  vaultOwnerToken={vaultOwnerToken}
                  onRetrace={onRetrace}
                />
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Sage tracing a real paper's citation lineage in both directions --
 * "Citation Lineage & Tree Traversal" from the researcher-agent vision,
 * built against OpenAlex (free, unauthenticated) rather than Semantic
 * Scholar (which 429'd on the very first live call while building this).
 * Rendered as a vertical spine (references above, the traced paper as the
 * anchor, citing works below) where every node expands IN PLACE via
 * LineageNode -- clicking a reference nests its own references underneath
 * it instead of replacing the screen, so you don't lose your place. This
 * is deliberately a CSS/SVG-free tree (no force-directed graph dependency
 * exists in this app) rather than a pannable node-link canvas.
 */
export function CitationLineagePanel() {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const searchParams = useSearchParams();
  const threadId = searchParams.get("threadId");
  const deepLinkWorkId = searchParams.get("workId");
  const deepLinkTitle = searchParams.get("title");
  const deepLinkOpened = useRef(false);

  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [saveDomain, setSaveDomain] = useState<string>("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [addToThreadState, setAddToThreadState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Paper[]>([]);

  const [trail, setTrail] = useState<Paper[]>([]);
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [loadingLineage, setLoadingLineage] = useState(false);
  const [lineageError, setLineageError] = useState<string | null>(null);
  const [insight, setInsight] = useState<{ loading: boolean; text: string | null }>({
    loading: false,
    text: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!user?.uid || !vaultOwnerToken) return;
      try {
        const metadata = await PersonalKnowledgeModelService.getMetadata(user.uid, false, vaultOwnerToken);
        if (!cancelled) {
          setDomains(metadata.domains);
          setSaveDomain(metadata.domains[0]?.key || "");
        }
      } catch {
        // Non-critical -- saving to notes is a secondary action here.
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [user, vaultOwnerToken]);

  useEffect(() => {
    let cancelled = false;
    const workId = lineage?.paper.id;
    if (!workId || !vaultOwnerToken) {
      setInsight({ loading: false, text: null });
      return;
    }
    setInsight({ loading: true, text: null });
    void (async () => {
      try {
        const response = await ApiService.getSagePaperInsight({ vaultOwnerToken, workId });
        const data = response.ok ? await response.json() : null;
        if (!cancelled) setInsight({ loading: false, text: data?.insight || null });
      } catch {
        if (!cancelled) setInsight({ loading: false, text: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lineage?.paper.id, vaultOwnerToken]);

  async function handleSearch() {
    const trimmed = query.trim();
    if (!trimmed || !vaultOwnerToken || searching) return;
    setSearching(true);
    setSearchError(null);
    try {
      const response = await ApiService.searchSagePapers({ vaultOwnerToken, query: trimmed });
      if (!response.ok) throw new Error("Search failed just now.");
      const data = await response.json();
      const results = Array.isArray(data.results) ? data.results.map(parsePaper) : [];
      setCandidates(results);
      if (results.length === 0) setSearchError("No papers matched that search.");
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed just now.");
    } finally {
      setSearching(false);
    }
  }

  async function openPaper(paper: Paper) {
    if (!vaultOwnerToken || loadingLineage) return;
    setLoadingLineage(true);
    setLineageError(null);
    setCandidates([]);
    setSaveState("idle");
    setAddToThreadState("idle");
    try {
      const response = await ApiService.getSagePaperLineage({ vaultOwnerToken, workId: paper.id });
      if (!response.ok) throw new Error("Couldn't trace that paper's citations just now.");
      const data = await response.json();
      const references: Paper[] = Array.isArray(data.references) ? data.references.map(parsePaper) : [];
      const citedBy: Paper[] = Array.isArray(data.cited_by) ? data.cited_by.map(parsePaper) : [];
      setLineage({
        paper: parsePaper(data.paper),
        // Most-cited (most foundational) reference first -- same "what actually
        // matters here" ordering OpenAlex already gives us for citedBy.
        references: references.slice().sort((a, b) => b.citedByCount - a.citedByCount),
        citedBy,
      });
      setTrail((prev) => {
        const existingIndex = prev.findIndex((p) => p.id === paper.id);
        if (existingIndex >= 0) return prev.slice(0, existingIndex + 1);
        return [...prev, paper];
      });
    } catch (err) {
      setLineageError(err instanceof Error ? err.message : "Couldn't trace that paper's citations just now.");
    } finally {
      setLoadingLineage(false);
    }
  }

  useEffect(() => {
    if (deepLinkOpened.current || !deepLinkWorkId || !vaultOwnerToken) return;
    deepLinkOpened.current = true;
    void openPaper({
      id: deepLinkWorkId,
      title: deepLinkTitle || "Untitled",
      year: null,
      authors: [],
      citedByCount: 0,
      topic: null,
    });
    // openPaper is stable across renders in practice (redefined each render but
    // reads only current state/props); this should fire once per deep link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkWorkId, vaultOwnerToken]);

  async function handleSaveToNotes() {
    if (!lineage || !user?.uid || !vaultKey || !vaultOwnerToken || !saveDomain) return;
    setSaveState("saving");
    try {
      const { paper } = lineage;
      const noteText = `Sage citation trace: "${paper.title}"${paper.year ? ` (${paper.year})` : ""}${
        authorLine(paper.authors) ? ` by ${authorLine(paper.authors)}` : ""
      } -- cites ${lineage.references.length} works, cited by ${paper.citedByCount}.`;
      // Re-fetch live rather than trusting the `domains` prop -- see the
      // matching comment in ask-sage-panel.tsx's handleSave for why a stale
      // snapshot here silently overwrites an earlier save's highlight line.
      const freshDomains = await PersonalKnowledgeModelService.getMetadata(user.uid, true, vaultOwnerToken)
        .then((m) => m.domains)
        .catch(() => domains);
      const targetDomain = freshDomains.find((d) => d.key === saveDomain) || domains.find((d) => d.key === saveDomain);
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId: user.uid,
        domain: saveDomain,
        vaultKey,
        vaultOwnerToken,
        build: (context) => ({
          domainData: addNoteEntity(context.currentDomainData, noteText, "sage_citation"),
          summary: {
            source: "sage_citation",
            message_excerpt: noteText.slice(0, 160),
            ...buildSageNoteSummaryPatch({
              displayName: targetDomain?.displayName || saveDomain,
              existingHighlights: targetDomain?.readableHighlights || [],
              noteText,
            }),
          },
        }),
      });
      setSaveState(result.success ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
  }

  async function handleAddToThread() {
    if (!lineage || !threadId || !user?.uid || !vaultKey || !vaultOwnerToken) return;
    setAddToThreadState("saving");
    try {
      const { paper } = lineage;
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId: user.uid,
        domain: RESEARCH_DOMAIN,
        vaultKey,
        vaultOwnerToken,
        build: (context) => {
          const updated = addTracedPaperToThread(context.currentDomainData, threadId, {
            id: paper.id,
            title: paper.title,
            year: paper.year,
            topic: paper.topic,
            citedByCount: paper.citedByCount,
          });
          const threadsAfter = listResearchThreads(updated);
          return {
            domainData: updated,
            mergeDecision: { merge_mode: "replace_domain" },
            summary: { source: "sage_citation_thread", ...buildResearchThreadsSummaryPatch(threadsAfter) },
          };
        },
      });
      setAddToThreadState(result.success ? "saved" : "error");
    } catch {
      setAddToThreadState("error");
    }
  }

  function resetSearch() {
    setLineage(null);
    setTrail([]);
    setCandidates([]);
    setSearchError(null);
    setLineageError(null);
  }

  return (
    <div className="space-y-4">
      {threadId ? (
        <Link
          href={ROUTES.SAGE_THREADS}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Back to research thread
        </Link>
      ) : null}

      <div className="rounded-2xl border border-violet-500/25 bg-card/85 p-5 shadow-[0_1px_2px_rgba(15,23,42,0.06)] sm:p-6">
        <div className="flex items-center gap-2 text-base font-semibold text-violet-700 dark:text-violet-300">
          <GitBranch className="h-5 w-5" aria-hidden />
          Trace a paper
        </div>
        <p className="mt-1.5 text-base text-muted-foreground">
          Search a paper by title, then see what it builds on and what builds on it -- real citation
          data, not a summary.
        </p>
        <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleSearch();
              }
            }}
            placeholder="e.g. Attention Is All You Need"
            className="h-12 flex-1 text-base"
          />
          <Button
            onClick={() => void handleSearch()}
            disabled={searching || !query.trim()}
            className="h-12 px-6 text-base sm:w-auto"
          >
            <Search className="mr-1.5 h-4 w-4" aria-hidden />
            {searching ? "Searching…" : "Search"}
          </Button>
        </div>
        {searchError ? <p className="mt-2.5 text-sm text-destructive">{searchError}</p> : null}

        {candidates.length === 0 && !lineage && !loadingLineage ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Try:</span>
            {EXAMPLE_QUERIES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  setQuery(example);
                  void handleSearch();
                }}
                className="rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-violet-500/40 hover:text-foreground"
              >
                {example}
              </button>
            ))}
          </div>
        ) : null}

        {candidates.length > 0 ? (
          <div className="mt-4 space-y-2.5">
            {candidates.map((paper) => (
              <button
                key={paper.id}
                type="button"
                onClick={() => void openPaper(paper)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 p-4 text-left transition-colors hover:border-violet-500/40"
              >
                <div className="min-w-0">
                  <p className="text-base font-medium leading-snug text-foreground">{paper.title}</p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                    {[paper.year, authorLine(paper.authors)].filter(Boolean).join(" · ")}
                    <CitationChip count={paper.citedByCount} />
                    <TopicChip topic={paper.topic} />
                  </p>
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {trail.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {trail.map((paper, index) => {
            const isCurrent = index === trail.length - 1;
            return (
              <span key={paper.id} className="flex items-center gap-2">
                {index > 0 ? <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> : null}
                {isCurrent ? (
                  <span className="max-w-[18rem] truncate rounded-full bg-violet-500/15 px-3 py-1.5 font-medium text-violet-700 dark:text-violet-300">
                    {paper.title}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void openPaper(paper)}
                    className="max-w-[18rem] truncate rounded-full border border-border/60 bg-card px-3 py-1.5 text-muted-foreground hover:border-violet-500/40 hover:text-foreground"
                  >
                    {paper.title}
                  </button>
                )}
              </span>
            );
          })}
          <button
            type="button"
            onClick={resetSearch}
            className="ml-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            New search
          </button>
        </div>
      ) : null}

      {loadingLineage ? (
        <div className="space-y-2.5 border-l-2 border-violet-500/10 pl-6">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}
      {loadingLineage ? (
        <div className="rounded-2xl border border-border/60 bg-card/85 p-5 sm:p-6">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="mt-3 h-4 w-1/2" />
        </div>
      ) : null}
      {loadingLineage ? (
        <div className="space-y-2.5 border-l-2 border-violet-500/10 pl-6">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}

      {lineageError ? <p className="text-sm text-destructive">{lineageError}</p> : null}

      {lineage && !loadingLineage ? (
        <>
          <SectionHeader
            icon={ArrowDownToLine}
            label="Builds on"
            count={lineage.references.length}
            sub="What this paper cites, most-foundational first"
          />
          {lineage.references.length === 0 ? (
            <p className="text-sm text-muted-foreground">No references found.</p>
          ) : (
            <div className="space-y-2.5 border-l-2 border-violet-500/20 pl-6">
              {(() => {
                const max = Math.max(1, ...lineage.references.map((p) => p.citedByCount));
                return lineage.references.map((paper, index) => (
                  <LineageNode
                    key={paper.id}
                    paper={paper}
                    direction="back"
                    depth={0}
                    rank={index + 1}
                    siblingMax={max}
                    vaultOwnerToken={vaultOwnerToken}
                    onRetrace={(p) => void openPaper(p)}
                  />
                ));
              })()}
            </div>
          )}

          <div className="flex justify-center">
            <div className="h-6 w-0.5 bg-gradient-to-b from-violet-500/20 to-violet-500/40" aria-hidden />
          </div>

          <div className="relative overflow-hidden rounded-2xl border border-violet-500/25 bg-gradient-to-br from-violet-500/[0.07] to-transparent p-5 dark:border-violet-400/25 dark:from-violet-400/[0.06] sm:p-6">
            <span className="text-xs font-medium uppercase tracking-wide text-violet-700/80 dark:text-violet-300/80">
              Currently tracing
            </span>
            <p className="mt-1.5 text-xl font-semibold leading-snug text-foreground">
              {lineage.paper.title}
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2 text-base text-muted-foreground">
              {[lineage.paper.year, authorLine(lineage.paper.authors)].filter(Boolean).join(" · ")}
              <CitationChip count={lineage.paper.citedByCount} />
              <TopicChip topic={lineage.paper.topic} />
            </div>

            <div className="mt-3.5 flex items-start gap-2 border-t border-violet-500/15 pt-3.5 dark:border-violet-400/15">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
              {insight.loading ? (
                <div className="flex-1 space-y-1.5 pt-0.5">
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3.5 w-4/5" />
                </div>
              ) : insight.text ? (
                <p className="text-sm leading-6 text-foreground">{insight.text}</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Sage couldn&apos;t read this one just now.
                </p>
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              {domains.length > 0 ? (
                <>
                  <select
                    value={saveDomain}
                    onChange={(event) => setSaveDomain(event.target.value)}
                    className="h-10 rounded-md border border-border/60 bg-card px-3 text-sm text-foreground"
                    disabled={saveState === "saving" || saveState === "saved"}
                  >
                    {domains.map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.displayName}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    onClick={() => void handleSaveToNotes()}
                    disabled={saveState === "saving" || saveState === "saved"}
                    className="h-10"
                  >
                    {saveState === "saving"
                      ? "Saving…"
                      : saveState === "saved"
                        ? "Saved"
                        : saveState === "error"
                          ? "Retry save"
                          : "Save to notes"}
                  </Button>
                </>
              ) : null}
              {threadId ? (
                <Button
                  variant="outline"
                  onClick={() => void handleAddToThread()}
                  disabled={addToThreadState === "saving" || addToThreadState === "saved"}
                  className="h-10"
                >
                  <FlaskConical className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {addToThreadState === "saving"
                    ? "Adding…"
                    : addToThreadState === "saved"
                      ? "Added to thread"
                      : addToThreadState === "error"
                        ? "Retry add"
                        : "Add to research thread"}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="flex justify-center">
            <div className="h-6 w-0.5 bg-gradient-to-b from-violet-500/40 to-violet-500/20" aria-hidden />
          </div>

          <SectionHeader
            icon={ArrowUpFromLine}
            label="Built on by"
            count={lineage.citedBy.length}
            sub="What cites this paper, most-cited first"
          />
          {lineage.citedBy.length === 0 ? (
            <p className="text-sm text-muted-foreground">No citing works found.</p>
          ) : (
            <div className="space-y-2.5 border-l-2 border-violet-500/20 pl-6">
              {(() => {
                const max = Math.max(1, ...lineage.citedBy.map((p) => p.citedByCount));
                return lineage.citedBy.map((paper, index) => (
                  <LineageNode
                    key={paper.id}
                    paper={paper}
                    direction="forward"
                    depth={0}
                    rank={index + 1}
                    siblingMax={max}
                    vaultOwnerToken={vaultOwnerToken}
                    onRetrace={(p) => void openPaper(p)}
                  />
                ));
              })()}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

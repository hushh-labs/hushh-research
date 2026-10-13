"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";
import {
  ArrowLeft,
  Archive,
  CheckCircle2,
  CircleHelp,
  Download,
  ExternalLink,
  FlaskConical,
  Gauge,
  GitBranch,
  Link2,
  MessageSquare,
  Quote,
  Sparkles,
  Tag,
  User,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { HealthRadarCard, type HealthRadarAxis } from "@/components/sage/health-radar-card";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { ApiService } from "@/lib/services/api-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { PersonalKnowledgeModelService, type DomainSummary } from "@/lib/services/personal-knowledge-model-service";
import {
  addTracedPaperToThread,
  appendThreadTurn,
  archiveResearchThread,
  buildResearchThreadsSummaryPatch,
  createResearchThread,
  listResearchThreads,
  removeTracedPaperFromThread,
  updateThreadSynthesis,
  type ResearchThreadComparison,
  type ResearchThreadEntity,
  type ResearchThreadKeyTerm,
  type ResearchThreadPaper,
  type ResearchThreadSource,
  type ResearchThreadTurn,
} from "@/lib/sage/research-thread-entity";
import { ChapteredAnswer } from "@/components/sage/chaptered-answer";
import { SageLoadingIndicator } from "@/components/sage/sage-loading-indicator";
import { buildSageCitationsRoute } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

const RESEARCH_DOMAIN = "research";

type View = { mode: "list" } | { mode: "detail"; threadId: string };

type AnswerLength = "standard" | "thorough" | "exhaustive";

const ANSWER_LENGTH_OPTIONS: Array<{ value: AnswerLength; label: string; hint: string }> = [
  { value: "standard", label: "Standard", hint: "A few thorough paragraphs (~8k characters)" },
  { value: "thorough", label: "Thorough", hint: "Sectioned, in-depth answer (~14k characters)" },
  { value: "exhaustive", label: "Exhaustive", hint: "Full reference write-up (~20k characters)" },
];

// Roughly matches the backend's per-tier timeout (_DEEP_LENGTH_TIMEOUT_SECONDS
// in pkm_highlight.py), scaled down a bit from the worst case to reflect a
// typical call -- used only to pace SageLoadingIndicator's status cycling
// and its "still working" reassurance, never shown as a literal countdown.
const ANSWER_LENGTH_EXPECTED_SECONDS: Record<AnswerLength, number> = {
  standard: 20,
  thorough: 35,
  exhaustive: 50,
};

/**
 * Only 3 real backend tiers exist (each maps to its own prompt instruction,
 * generation token budget, and timeout server-side) -- a continuous slider
 * would imply finer control than actually exists, so this is a segmented
 * toggle instead.
 */
function AnswerLengthControl({
  value,
  onChange,
  disabled,
}: {
  value: AnswerLength;
  onChange: (value: AnswerLength) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Answer length</span>
      <div className="flex items-center gap-0.5 rounded-full border border-border/60 bg-card p-0.5">
        {ANSWER_LENGTH_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            disabled={disabled}
            aria-pressed={value === option.value}
            title={option.hint}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60",
              value === option.value
                ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * How resolved a thread's synthesis is, at a glance -- a real proportion of
 * the actual established/open-question counts already on the synthesis,
 * not a separately invented "alignment score".
 */
function SynthesisRatioBar({ established, open }: { established: number; open: number }) {
  const total = established + open;
  if (total === 0) return null;
  const establishedPct = Math.round((established / total) * 100);
  return (
    <div className="mt-3 flex items-center gap-2.5 text-xs text-muted-foreground">
      <span className="shrink-0 text-emerald-700 dark:text-emerald-400">{established} established</span>
      <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted/40">
        <div className="h-full bg-emerald-500/70" style={{ width: `${establishedPct}%` }} />
        <div className="h-full bg-amber-500/70" style={{ width: `${100 - establishedPct}%` }} />
      </div>
      <span className="shrink-0 text-amber-700 dark:text-amber-400">{open} open</span>
    </div>
  );
}

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

function CitationChip({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300">
      <Quote className="h-2.5 w-2.5" aria-hidden />
      {count.toLocaleString()}
    </span>
  );
}

function TopicChip({ topic }: { topic: string | null }) {
  if (!topic) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
      <Tag className="h-2.5 w-2.5" aria-hidden />
      {topic}
    </span>
  );
}

/**
 * Click-to-reveal definitions for terms an answer actually used -- each
 * definition is grounded in that same answer (see _parse_deep_extras on the
 * backend), never a fresh lookup, so this can't introduce new claims.
 */
function KeyTermChips({ items }: { items: ResearchThreadKeyTerm[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-violet-500/10 pt-2.5">
      {items.map((item, index) => (
        <Popover key={index}>
          <PopoverTrigger className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/[0.06] px-2 py-0.5 text-xs font-medium text-violet-700 transition-colors hover:border-violet-500/50 dark:text-violet-300">
            {item.term}
          </PopoverTrigger>
          <PopoverContent className="w-64 text-sm">
            <p className="font-medium text-foreground">{item.term}</p>
            <p className="mt-1 text-muted-foreground">{item.definition}</p>
          </PopoverContent>
        </Popover>
      ))}
    </div>
  );
}

/**
 * The per-turn KeyTermChips above only show up buried inside whichever
 * message bubble first defined a term -- easy to miss once a thread has a
 * few turns. This aggregates every term across the whole thread (first
 * definition wins on a duplicate, case-insensitively) into one always-
 * visible glossary near the top, same click-to-reveal chip UI, just once
 * per thread instead of scattered per-message.
 */
function computeThreadGlossary(turns: ResearchThreadTurn[]): ResearchThreadKeyTerm[] {
  const seen = new Set<string>();
  const glossary: ResearchThreadKeyTerm[] = [];
  for (const turn of turns) {
    for (const item of turn.keyTerms) {
      const key = item.term.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      glossary.push(item);
    }
  }
  return glossary;
}

function ThreadGlossary({ turns }: { turns: ResearchThreadTurn[] }) {
  const glossary = useMemo(() => computeThreadGlossary(turns), [turns]);
  if (glossary.length === 0) return null;
  return (
    <div className="rounded-2xl border border-border/60 bg-card/85 p-4">
      <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Tag className="h-4 w-4 text-violet-700 dark:text-violet-300" aria-hidden />
        Glossary
      </span>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {glossary.map((item, index) => (
          <Popover key={index}>
            <PopoverTrigger className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/[0.06] px-2.5 py-1 text-xs font-medium text-violet-700 transition-colors hover:border-violet-500/50 dark:text-violet-300">
              {item.term}
            </PopoverTrigger>
            <PopoverContent className="w-64 text-sm">
              <p className="font-medium text-foreground">{item.term}</p>
              <p className="mt-1 text-muted-foreground">{item.definition}</p>
            </PopoverContent>
          </Popover>
        ))}
      </div>
    </div>
  );
}

/**
 * Serializes a thread to portable Markdown -- title, synthesis, every turn
 * with its sources, traced papers, and the glossary. Privacy-first personal
 * data shouldn't be a one-way door: making it trivial to take your own
 * research out of the app (no server round-trip, this is just the same
 * data already loaded, restructured as text) is the honest counterpart to
 * the BYOK/E2E-encryption pitch the rest of Sage is built on.
 */
function buildThreadMarkdown(thread: ResearchThreadEntity): string {
  const lines: string[] = [`# ${thread.title}`, ""];

  if (thread.synthesis) {
    lines.push("## What we know so far", "", thread.synthesis.summary, "");
    if (thread.synthesis.established.length > 0) {
      lines.push("### Established", "", ...thread.synthesis.established.map((item) => `- ${item}`), "");
    }
    if (thread.synthesis.openQuestions.length > 0) {
      lines.push("### Open questions", "", ...thread.synthesis.openQuestions.map((item) => `- ${item}`), "");
    }
  }

  const glossary = computeThreadGlossary(thread.turns);
  if (glossary.length > 0) {
    lines.push("## Glossary", "");
    for (const item of glossary) lines.push(`- **${item.term}**: ${item.definition}`);
    lines.push("");
  }

  if (thread.turns.length > 0) {
    lines.push("## Questions & answers", "");
    thread.turns.forEach((turn, index) => {
      lines.push(`### ${index + 1}. ${turn.query}`, "", turn.answer, "");
      if (turn.sources.length > 0) {
        lines.push(...turn.sources.map((s) => `- [${s.title}](${s.url})`), "");
      }
    });
  }

  if (thread.tracedPapers.length > 0) {
    lines.push("## Traced papers", "");
    for (const paper of thread.tracedPapers) {
      const year = paper.year ? ` (${paper.year})` : "";
      lines.push(`- ${paper.title}${year} -- cited by ${paper.citedByCount}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function downloadThreadMarkdown(thread: ResearchThreadEntity): void {
  const markdown = buildThreadMarkdown(thread);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const filename = `${thread.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) || "research-thread"}.md`;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

type RelatedThread = {
  thread: ResearchThreadEntity;
  sharedTerms: string[];
  sharedPaperTitles: string[];
};

function collectTermMap(thread: ResearchThreadEntity): Map<string, string> {
  const map = new Map<string, string>();
  for (const turn of thread.turns) {
    for (const item of turn.keyTerms) {
      const key = item.term.trim().toLowerCase();
      if (key && !map.has(key)) map.set(key, item.term.trim());
    }
  }
  return map;
}

/**
 * Surfaces OTHER active threads that overlap with this one -- by shared key
 * terms or shared traced papers -- turning a flat list of separate
 * investigations into something closer to an actual personal knowledge
 * graph. Pure client-side computation over threads already loaded (no new
 * backend call, no LLM judgment call about "relatedness" to get wrong).
 */
function computeRelatedThreads(thread: ResearchThreadEntity, allThreads: ResearchThreadEntity[]): RelatedThread[] {
  const ownTermMap = collectTermMap(thread);
  const ownPaperIds = new Set(thread.tracedPapers.map((p) => p.id));

  const related: RelatedThread[] = [];
  for (const other of allThreads) {
    if (other.entityId === thread.entityId || other.status !== "active") continue;
    const otherTermMap = collectTermMap(other);
    const sharedTerms = [...otherTermMap.keys()]
      .filter((key) => ownTermMap.has(key))
      .map((key) => ownTermMap.get(key) as string);
    const sharedPapers = other.tracedPapers.filter((p) => ownPaperIds.has(p.id));
    if (sharedTerms.length === 0 && sharedPapers.length === 0) continue;
    related.push({ thread: other, sharedTerms, sharedPaperTitles: sharedPapers.map((p) => p.title) });
  }
  return related.sort(
    (a, b) =>
      b.sharedTerms.length + b.sharedPaperTitles.length - (a.sharedTerms.length + a.sharedPaperTitles.length),
  );
}

function RelatedThreadsCard({
  related,
  onOpenThread,
}: {
  related: RelatedThread[];
  onOpenThread: (threadId: string) => void;
}) {
  if (related.length === 0) return null;
  return (
    <div className="rounded-2xl border border-border/60 bg-card/85 p-4">
      <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Link2 className="h-4 w-4 text-violet-700 dark:text-violet-300" aria-hidden />
        Related threads
      </span>
      <div className="mt-2.5 space-y-2">
        {related.slice(0, 4).map((r) => (
          <button
            key={r.thread.entityId}
            type="button"
            onClick={() => onOpenThread(r.thread.entityId)}
            className="flex w-full flex-col gap-1 rounded-lg border border-border/50 bg-background/60 p-2.5 text-left transition-colors hover:border-violet-500/40"
          >
            <span className="text-sm font-medium text-foreground">{r.thread.title}</span>
            <span className="text-xs text-muted-foreground">
              {[
                r.sharedTerms.length > 0 ? `shares "${r.sharedTerms.slice(0, 2).join('", "')}"` : null,
                r.sharedPaperTitles.length > 0
                  ? `${r.sharedPaperTitles.length} shared paper${r.sharedPaperTitles.length === 1 ? "" : "s"}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const sageComparisonChartConfig = {
  value: {
    label: "Value",
    color: "rgb(139 92 246)", // violet-500, matching Sage's accent everywhere else in this panel
  },
} satisfies ChartConfig;

function compactChartLabel(value: string, max = 18): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * One real bar chart (recharts, via the same ChartContainer/ChartTooltip
 * wrapper the Kai dashboard views use) for a single same-unit group of
 * comparable numbers -- not a full-size dashboard panel, sized to just fit
 * its handful of rows since it sits inline in a chat bubble.
 */
function SageComparisonChart({ unit, items }: { unit: string; items: ResearchThreadComparison[] }) {
  const data = items.map((item) => ({ name: item.label, value: item.value }));
  const height = Math.max(56, items.length * 34);
  return (
    <ChartContainer config={sageComparisonChartConfig} className="w-full" style={{ height }}>
      <BarChart accessibilityLayer data={data} layout="vertical" margin={{ left: 4, right: 44, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" strokeOpacity={0.35} />
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          width={108}
          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          tickFormatter={(value) => compactChartLabel(String(value))}
          axisLine={false}
          tickLine={false}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              hideLabel
              formatter={(value, _name, item) => {
                const payload = item?.payload as { name?: string } | undefined;
                return (
                  <div className="flex min-w-[8rem] flex-col gap-0.5">
                    <span className="text-[11px] font-semibold text-foreground">{payload?.name}</span>
                    <span className="text-sm font-semibold text-foreground">
                      {Number(value).toLocaleString()}
                      {unit ? ` ${unit}` : ""}
                    </span>
                  </div>
                );
              }}
            />
          }
        />
        <Bar dataKey="value" fill="var(--color-value)" radius={[0, 4, 4, 0]} barSize={14}>
          <LabelList
            dataKey="value"
            position="right"
            fontSize={10}
            fill="var(--foreground)"
            formatter={(val: number) => `${val.toLocaleString()}${unit ? ` ${unit}` : ""}`}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

/**
 * Real numbers an answer already stated, charted -- grouped by unit rather
 * than one shared chart: the prompt asks the model for a single same-unit
 * set, but if it ever slips in two kinds of number (e.g. a score and a
 * distance metric), plotting them on one shared axis would make one look
 * negligible for no real reason. Only rendered when the model actually
 * found something genuinely comparable.
 */
function ComparisonBars({ items }: { items: ResearchThreadComparison[] }) {
  if (items.length === 0) return null;
  const groups = new Map<string, ResearchThreadComparison[]>();
  for (const item of items) {
    const key = item.unit || "";
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }
  return (
    <div className="mt-2.5 space-y-3 border-t border-violet-500/10 pt-2.5">
      {Array.from(groups.entries()).map(([unit, groupItems]) => (
        <SageComparisonChart key={unit || "unitless"} unit={unit} items={groupItems} />
      ))}
    </div>
  );
}

/**
 * A profile of how mature THIS INVESTIGATION is, not the topic itself --
 * there's no universal rubric for scoring an arbitrary research subject
 * (unlike Kai's portfolio health, which scores a fixed financial domain),
 * so this deliberately scores the thread's own research process instead,
 * using only real, already-present data:
 *  - Depth: how many questions have been asked
 *  - Evidence: how many real web sources were found across all turns
 *  - Grounding: what fraction of turns actually returned live search sources
 *    (vs. answered from the model's own knowledge)
 *  - Consensus: established vs. open-question ratio from the synthesis
 *  - Breadth: how many distinct key terms have come up
 *  - Currency: how recent the traced papers are, on average
 * Every axis is a straight count/ratio over data already on the thread --
 * nothing here is invented or separately generated.
 */
function computeResearchHealth(thread: ResearchThreadEntity): { axes: HealthRadarAxis[]; overall: number } {
  const turnCount = thread.turns.length;
  const totalSources = thread.turns.reduce((sum, t) => sum + t.sources.length, 0);
  const turnsWithSources = thread.turns.filter((t) => t.sources.length > 0).length;
  const uniqueTerms = new Set(thread.turns.flatMap((t) => t.keyTerms.map((k) => k.term.trim().toLowerCase())));
  const establishedCount = thread.synthesis?.established.length ?? 0;
  const openCount = thread.synthesis?.openQuestions.length ?? 0;
  const consensusTotal = establishedCount + openCount;

  const currentYear = new Date().getFullYear();
  const papersWithYear = thread.tracedPapers.filter((p) => typeof p.year === "number");
  const currency =
    papersWithYear.length === 0
      ? 0
      : papersWithYear.reduce((sum, p) => {
          const age = currentYear - (p.year as number);
          return sum + Math.max(0, Math.min(100, 100 - age * 10));
        }, 0) / papersWithYear.length;

  const axes: HealthRadarAxis[] = [
    { subject: "Depth", value: Math.min(100, turnCount * 25) },
    { subject: "Evidence", value: Math.min(100, totalSources * 12.5) },
    { subject: "Grounding", value: turnCount === 0 ? 0 : Math.round((turnsWithSources / turnCount) * 100) },
    { subject: "Consensus", value: consensusTotal === 0 ? 0 : Math.round((establishedCount / consensusTotal) * 100) },
    { subject: "Breadth", value: Math.min(100, uniqueTerms.size * 12.5) },
    { subject: "Currency", value: Math.round(currency) },
  ];
  const overall = Math.round(axes.reduce((sum, axis) => sum + axis.value, 0) / axes.length);
  return { axes, overall };
}

function ResearchHealthPanel({ thread }: { thread: ResearchThreadEntity }) {
  const { axes, overall } = useMemo(() => computeResearchHealth(thread), [thread]);
  return (
    <HealthRadarCard
      icon={Gauge}
      title="Investigation health"
      axes={axes}
      overall={overall}
      scaleLabels={["Early", "Developing", "Well-established"]}
    />
  );
}

function askDomains(domains: DomainSummary[]) {
  return domains.map((d) => ({
    domain: d.key,
    displayName: d.displayName,
    summary: d.summary,
    attributeCount: d.attributeCount,
  }));
}

/**
 * Owns its own query/loading/error state so typing here never re-renders
 * the (potentially large, markdown-heavy) thread list above it -- keeping
 * this input's state in the parent caused every keystroke to re-render
 * every thread card, which visibly flickered.
 */
function NewThreadBox({
  personalDomains,
  vaultOwnerToken,
  onCreate,
}: {
  personalDomains: DomainSummary[];
  vaultOwnerToken: string | null;
  onCreate: (
    query: string,
    answer: string,
    sources: ResearchThreadSource[],
    keyTerms: ResearchThreadKeyTerm[],
    comparisons: ResearchThreadComparison[],
    paperSearchQuery: string | null,
  ) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [length, setLength] = useState<AnswerLength>("standard");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    const trimmed = query.trim();
    if (!trimmed || !vaultOwnerToken || creating) return;
    setCreating(true);
    setError(null);
    try {
      const response = await ApiService.askSage({
        vaultOwnerToken,
        query: trimmed,
        mode: "standard",
        depth: "deep",
        length,
        domains: askDomains(personalDomains),
      });
      if (!response.ok) throw new Error("Sage couldn't research that just now.");
      const data = await response.json();
      const answer = String(data.answer || "");
      const sources: ResearchThreadSource[] = Array.isArray(data.sources) ? data.sources : [];
      const keyTerms: ResearchThreadKeyTerm[] = Array.isArray(data.key_terms) ? data.key_terms : [];
      const comparisons: ResearchThreadComparison[] = Array.isArray(data.comparisons) ? data.comparisons : [];
      const paperSearchQuery: string | null = typeof data.paper_search_query === "string" ? data.paper_search_query : null;
      await onCreate(trimmed, answer, sources, keyTerms, comparisons, paperSearchQuery);
      setQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start that thread just now.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="rounded-2xl border border-violet-500/25 bg-card/85 p-5 shadow-[0_1px_2px_rgba(15,23,42,0.06)] sm:p-6">
      <div className="flex items-center gap-2 text-base font-semibold text-violet-700 dark:text-violet-300">
        <FlaskConical className="h-5 w-5" aria-hidden />
        Start a new research thread
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Ask a real question. Sage will keep working on it with you across visits -- not just one
        answer, an ongoing investigation.
      </p>
      <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
        <Textarea
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleCreate();
            }
          }}
          placeholder="e.g. Are transformers better than RNNs for long-context tasks?"
          className="min-h-[2.75rem] flex-1 resize-none"
          rows={2}
        />
        <Button onClick={() => void handleCreate()} disabled={creating || !query.trim()}>
          {creating ? "Starting…" : "Start thread"}
        </Button>
      </div>
      <div className="mt-2.5">
        <AnswerLengthControl value={length} onChange={setLength} disabled={creating} />
      </div>
      <SageLoadingIndicator active={creating} expectedSeconds={ANSWER_LENGTH_EXPECTED_SECONDS[length]} />
      {error ? <p className="mt-2.5 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * Same isolation as NewThreadBox above, for the same reason: typing a
 * follow-up must not re-render the turn history / synthesis block sitting
 * next to it.
 */
function FollowUpAskBox({
  thread,
  personalDomains,
  vaultOwnerToken,
  onAnswered,
}: {
  thread: ResearchThreadEntity;
  personalDomains: DomainSummary[];
  vaultOwnerToken: string | null;
  onAnswered: (
    query: string,
    answer: string,
    sources: ResearchThreadSource[],
    keyTerms: ResearchThreadKeyTerm[],
    comparisons: ResearchThreadComparison[],
    paperSearchQuery: string | null,
  ) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [length, setLength] = useState<AnswerLength>("standard");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAsk() {
    const trimmed = query.trim();
    if (!trimmed || !vaultOwnerToken || asking) return;
    setAsking(true);
    setError(null);
    try {
      const conversationHistory = thread.turns.slice(-4).map((t) => ({ query: t.query, answer: t.answer }));
      const response = await ApiService.askSage({
        vaultOwnerToken,
        query: trimmed,
        mode: "standard",
        depth: "deep",
        length,
        domains: askDomains(personalDomains),
        conversationHistory,
      });
      if (!response.ok) throw new Error("Sage couldn't research that just now.");
      const data = await response.json();
      const answer = String(data.answer || "");
      const sources: ResearchThreadSource[] = Array.isArray(data.sources) ? data.sources : [];
      const keyTerms: ResearchThreadKeyTerm[] = Array.isArray(data.key_terms) ? data.key_terms : [];
      const comparisons: ResearchThreadComparison[] = Array.isArray(data.comparisons) ? data.comparisons : [];
      const paperSearchQuery: string | null = typeof data.paper_search_query === "string" ? data.paper_search_query : null;
      await onAnswered(trimmed, answer, sources, keyTerms, comparisons, paperSearchQuery);
      setQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sage couldn't research that just now.");
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border/60 bg-card/85 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Textarea
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleAsk();
            }
          }}
          placeholder="Ask a follow-up…"
          className="min-h-[2.75rem] flex-1 resize-none"
          rows={2}
        />
        <Button onClick={() => void handleAsk()} disabled={asking || !query.trim()}>
          {asking ? "Researching…" : "Ask"}
        </Button>
      </div>
      <div className="mt-2">
        <AnswerLengthControl value={length} onChange={setLength} disabled={asking} />
      </div>
      <SageLoadingIndicator active={asking} expectedSeconds={ANSWER_LENGTH_EXPECTED_SECONDS[length]} />
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * Sage as a persistent researcher instead of a one-shot chat: a named,
 * ongoing investigation that survives across visits, accumulating real
 * Q&A turns and traced papers, with a running synthesis of what's
 * established vs. still open. Stored in its own `research` PKM domain
 * (a new domain key -- the domain system is fully dynamic, no backend
 * schema change needed; confirmed live before building this) via the same
 * PkmWriteCoordinator.saveMergedDomain path every other Sage write uses.
 *
 * Every build() below returns `mergeDecision: { merge_mode: "replace_domain" }`.
 * Without it, saveMergedDomain's default "create_entity" mode re-derives the
 * write by heuristically extracting a single entity out of `domainData` and
 * splicing it into a separately-fetched base blob -- a heuristic built for
 * flat entity shapes like notes, not this domain's nested
 * turns/tracedPapers/synthesis structure. It silently discarded every new
 * thread while still reporting success, since our build() already does a
 * correct, complete read-modify-write against context.currentDomainData --
 * replace_domain tells the coordinator to persist that result verbatim.
 */
export function ResearchThreadsPanel() {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();

  const [loading, setLoading] = useState(true);
  const [threads, setThreads] = useState<ResearchThreadEntity[]>([]);
  const [personalDomains, setPersonalDomains] = useState<DomainSummary[]>([]);
  const [view, setView] = useState<View>({ mode: "list" });
  const [synthesisLoading, setSynthesisLoading] = useState(false);

  /**
   * Always called right after a write (create/append/synthesis/archive).
   * forceRefresh is required here: the cache invalidation that a write
   * triggers (CacheSyncService.onPkmDomainStored) goes through a
   * fire-and-forget dynamic import that isn't awaited by the write path,
   * so a stale-first read immediately after a write can race it and
   * return pre-write data -- e.g. a just-created thread not yet in
   * `threads`, making the detail view think it doesn't exist.
   */
  async function refreshThreads(): Promise<ResearchThreadEntity[]> {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) return [];
    const snapshot = await PkmDomainResourceService.getStaleFirst({
      userId: user.uid,
      domain: RESEARCH_DOMAIN,
      vaultKey,
      vaultOwnerToken,
      forceRefresh: true,
    });
    const parsed = listResearchThreads(snapshot?.data || {});
    setThreads(parsed);
    return parsed;
  }

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!user?.uid || !vaultKey || !vaultOwnerToken) {
        if (!cancelled) setLoading(false);
        return;
      }
      try {
        const [snapshot, metadata] = await Promise.all([
          PkmDomainResourceService.getStaleFirst({
            userId: user.uid,
            domain: RESEARCH_DOMAIN,
            vaultKey,
            vaultOwnerToken,
          }),
          PersonalKnowledgeModelService.getMetadata(user.uid, false, vaultOwnerToken),
        ]);
        if (!cancelled) {
          setThreads(listResearchThreads(snapshot?.data || {}));
          setPersonalDomains(metadata.domains);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [user, vaultKey, vaultOwnerToken]);

  /**
   * Runs whenever the viewed thread's content has changed since its last
   * synthesis: refreshes the synthesis AND auto-traces papers for the most
   * recent question, in ONE combined write. These used to be two separate
   * fire-and-forget writes (triggered right after each other from
   * handleThreadCreated/handleFollowUpAnswered) and they raced: both read
   * the same locally-cached pre-write snapshot, so whichever wrote second
   * hit a version conflict, retried against a cache that hadn't been
   * invalidated yet, and after exhausting its retries was silently
   * dropped -- confirmed live (traced papers landed, synthesis didn't).
   * Combining them into one write removes the race by construction.
   *
   * Order inside the write matters too: papers are added BEFORE the
   * synthesis timestamp is set, so synthesis.generatedAt always lands >=
   * the paper-add's updated_at bump within this same write -- otherwise
   * the staleness check below would see its own write as stale and loop.
   */
  async function enrichThreadAfterTurn(
    threadId: string,
    title: string,
    turns: ResearchThreadTurn[],
    tracedPapersBefore: ResearchThreadPaper[],
    paperSearchQuery: string | null,
  ) {
    if (!vaultOwnerToken || !user?.uid || !vaultKey) return;
    setSynthesisLoading(true);
    try {
      // Capped to match PkmSageThreadSynthesisRequest's max_length (turns:20,
      // traced_papers:30) on the backend -- a long-lived thread (the whole
      // point of Research Threads) past either limit used to 422 silently
      // (swallowed by the .catch below), freezing "What we know so far"
      // forever with no error shown. Most-recent turns kept since synthesis
      // cares about current state, not the earliest questions asked.
      const synthesisPromise = ApiService.getSageThreadSynthesis({
        vaultOwnerToken,
        title,
        turns: turns.slice(-20).map((t) => ({ query: t.query, answer: t.answer })),
        tracedPapers: tracedPapersBefore.slice(-30).map((p) => ({
          title: p.title,
          year: p.year,
          topic: p.topic,
          citedByCount: p.citedByCount,
        })),
      }).catch(() => null);
      const paperPromise = paperSearchQuery
        ? ApiService.searchSagePapers({ vaultOwnerToken, query: paperSearchQuery }).catch(() => null)
        : Promise.resolve(null);

      const [synthesisResponse, paperResponse] = await Promise.all([synthesisPromise, paperPromise]);
      const synthesisData = synthesisResponse?.ok ? await synthesisResponse.json() : null;
      const paperData = paperResponse?.ok ? await paperResponse.json() : null;
      const candidates = (Array.isArray(paperData?.results) ? paperData.results : []).slice(0, 2);

      if (!synthesisData && candidates.length === 0) return;

      await PkmWriteCoordinator.saveMergedDomain({
        userId: user.uid,
        domain: RESEARCH_DOMAIN,
        vaultKey,
        vaultOwnerToken,
        build: (context) => {
          let updated = context.currentDomainData;
          for (const candidate of candidates) {
            const id = String(candidate.id || "").trim();
            if (!id) continue;
            updated = addTracedPaperToThread(updated, threadId, {
              id,
              title: String(candidate.title || "Untitled"),
              year: typeof candidate.year === "number" ? candidate.year : null,
              topic: typeof candidate.topic === "string" ? candidate.topic : null,
              citedByCount: typeof candidate.cited_by_count === "number" ? candidate.cited_by_count : 0,
            });
          }
          if (synthesisData) {
            updated = updateThreadSynthesis(updated, threadId, {
              summary: String(synthesisData.summary || ""),
              established: Array.isArray(synthesisData.established) ? synthesisData.established : [],
              openQuestions: Array.isArray(synthesisData.open_questions) ? synthesisData.open_questions : [],
            });
          }
          const threadsAfter = listResearchThreads(updated);
          return {
            domainData: updated,
            mergeDecision: { merge_mode: "replace_domain" },
            summary: { source: "sage_research_thread_enrich", ...buildResearchThreadsSummaryPatch(threadsAfter) },
          };
        },
      });
      await refreshThreads();
    } catch {
      // Best-effort -- the turn itself already saved; revisiting the thread retries this.
    } finally {
      setSynthesisLoading(false);
    }
  }

  const activeThreadId = view.mode === "detail" ? view.threadId : null;
  const activeThread = activeThreadId ? threads.find((t) => t.entityId === activeThreadId) : undefined;

  useEffect(() => {
    if (!activeThreadId || !activeThread) return;
    if (activeThread.turns.length === 0 && activeThread.tracedPapers.length === 0) return;
    // Skip the (multi-second) LLM call if the stored synthesis was already
    // generated at or after the thread's last content change -- updateThreadSynthesis
    // never touches updatedAt, so this comparison is exact, not a heuristic.
    // Without it, every visit to an already-synthesized thread re-ran the full
    // synthesis call for no reason.
    const synthesisIsCurrent = Boolean(
      activeThread.synthesis?.generatedAt && activeThread.synthesis.generatedAt >= activeThread.updatedAt,
    );
    if (synthesisIsCurrent) return;
    const lastTurn = activeThread.turns[activeThread.turns.length - 1];
    void enrichThreadAfterTurn(
      activeThread.entityId,
      activeThread.title,
      activeThread.turns,
      activeThread.tracedPapers,
      lastTurn?.paperSearchQuery || null,
    );
    // Driven by updatedAt (bumped by any real content change: a new turn, or
    // a paper added from Citation Lineage) rather than turns.length alone,
    // so both sources of "this needs re-enrichment" are covered by one check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId, activeThread?.updatedAt]);

  async function handleThreadCreated(
    query: string,
    answer: string,
    sources: ResearchThreadSource[],
    keyTerms: ResearchThreadKeyTerm[],
    comparisons: ResearchThreadComparison[],
    paperSearchQuery: string | null,
  ) {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) return;
    let newThreadId = "";
    const result = await PkmWriteCoordinator.saveMergedDomain({
      userId: user.uid,
      domain: RESEARCH_DOMAIN,
      vaultKey,
      vaultOwnerToken,
      build: (context) => {
        const created = createResearchThread(context.currentDomainData, query);
        newThreadId = created.thread.entityId;
        const withTurn = appendThreadTurn(created.domainData, newThreadId, {
          query,
          answer,
          mode: "standard",
          sources,
          keyTerms,
          comparisons,
          paperSearchQuery,
        });
        const threadsAfter = listResearchThreads(withTurn);
        return {
          domainData: withTurn,
          mergeDecision: { merge_mode: "replace_domain" },
          summary: {
            source: "sage_research_thread",
            message_excerpt: query.slice(0, 160),
            ...buildResearchThreadsSummaryPatch(threadsAfter),
          },
        };
      },
    });
    if (!result.success) throw new Error(result.message || "Couldn't save that thread just now.");
    await refreshThreads();
    setView({ mode: "detail", threadId: newThreadId });
    // Enrichment (synthesis + auto-trace) runs from the staleness effect
    // above once this thread is the active view -- not triggered here
    // directly, so it never races a second write.
  }

  async function handleFollowUpAnswered(
    thread: ResearchThreadEntity,
    query: string,
    answer: string,
    sources: ResearchThreadSource[],
    keyTerms: ResearchThreadKeyTerm[],
    comparisons: ResearchThreadComparison[],
    paperSearchQuery: string | null,
  ) {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) return;
    await PkmWriteCoordinator.saveMergedDomain({
      userId: user.uid,
      domain: RESEARCH_DOMAIN,
      vaultKey,
      vaultOwnerToken,
      build: (context) => {
        const updated = appendThreadTurn(context.currentDomainData, thread.entityId, {
          query,
          answer,
          mode: "standard",
          sources,
          keyTerms,
          comparisons,
          paperSearchQuery,
        });
        const threadsAfter = listResearchThreads(updated);
        return {
          domainData: updated,
          mergeDecision: { merge_mode: "replace_domain" },
          summary: {
            source: "sage_research_thread",
            message_excerpt: query.slice(0, 160),
            ...buildResearchThreadsSummaryPatch(threadsAfter),
          },
        };
      },
    });
    // Enrichment runs from the staleness effect above (triggered by this
    // write's updated_at bump) instead of being called directly here --
    // same reasoning as handleThreadCreated.
    await refreshThreads();
  }

  async function handleArchiveThread(threadId: string) {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) return;
    await PkmWriteCoordinator.saveMergedDomain({
      userId: user.uid,
      domain: RESEARCH_DOMAIN,
      vaultKey,
      vaultOwnerToken,
      build: (context) => {
        const updated = archiveResearchThread(context.currentDomainData, threadId);
        const threadsAfter = listResearchThreads(updated);
        return {
          domainData: updated,
          mergeDecision: { merge_mode: "replace_domain" },
          summary: { source: "sage_research_thread_archive", ...buildResearchThreadsSummaryPatch(threadsAfter) },
        };
      },
    });
    await refreshThreads();
    setView({ mode: "list" });
  }

  async function handleRemoveTracedPaper(threadId: string, paperId: string) {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) return;
    await PkmWriteCoordinator.saveMergedDomain({
      userId: user.uid,
      domain: RESEARCH_DOMAIN,
      vaultKey,
      vaultOwnerToken,
      build: (context) => {
        const updated = removeTracedPaperFromThread(context.currentDomainData, threadId, paperId);
        const threadsAfter = listResearchThreads(updated);
        return {
          domainData: updated,
          mergeDecision: { merge_mode: "replace_domain" },
          summary: { source: "sage_research_thread_remove_paper", ...buildResearchThreadsSummaryPatch(threadsAfter) },
        };
      },
    });
    await refreshThreads();
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    );
  }

  if (view.mode === "detail") {
    const thread = threads.find((t) => t.entityId === view.threadId);
    if (!thread) {
      return (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setView({ mode: "list" })}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            All research threads
          </button>
          <p className="text-sm text-muted-foreground">That thread couldn&apos;t be found.</p>
        </div>
      );
    }

    const relative = formatRelativeTime(thread.updatedAt);
    const relatedThreads = computeRelatedThreads(thread, threads);

    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setView({ mode: "list" })}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          All research threads
        </button>

        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-700 dark:text-violet-300">
              <FlaskConical className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xl font-semibold leading-snug text-foreground">{thread.title}</p>
                {thread.status === "active" ? (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                    Active
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {relative ? <span>Updated {relative}</span> : null}
                <span className="inline-flex items-center gap-1">
                  <MessageSquare className="h-3 w-3" aria-hidden />
                  {thread.turns.length} question{thread.turns.length === 1 ? "" : "s"}
                </span>
                <span className="inline-flex items-center gap-1">
                  <GitBranch className="h-3 w-3" aria-hidden />
                  {thread.tracedPapers.length} paper{thread.tracedPapers.length === 1 ? "" : "s"} traced
                </span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadThreadMarkdown(thread)}
              className="text-muted-foreground"
            >
              <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Export
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleArchiveThread(thread.entityId)}
              className="text-muted-foreground"
            >
              <Archive className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Archive
            </Button>
          </div>
        </div>

        <RelatedThreadsCard
          related={relatedThreads}
          onOpenThread={(threadId) => setView({ mode: "detail", threadId })}
        />

        {thread.turns.length > 0 ? <ResearchHealthPanel thread={thread} /> : null}

        <div className="relative overflow-hidden rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-500/[0.06] to-transparent p-5 dark:border-violet-400/20 dark:from-violet-400/[0.05]">
          <span className="flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-300">
            <Sparkles className="h-4 w-4" aria-hidden />
            What we know so far
          </span>
          {synthesisLoading ? (
            <div className="mt-3 space-y-1.5">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
          ) : thread.synthesis ? (
            <>
              <p className="mt-2 text-[15px] leading-6 text-foreground">{thread.synthesis.summary}</p>
              <SynthesisRatioBar
                established={thread.synthesis.established.length}
                open={thread.synthesis.openQuestions.length}
              />
              {thread.synthesis.established.length > 0 || thread.synthesis.openQuestions.length > 0 ? (
                <div className="mt-3.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {thread.synthesis.established.length > 0 ? (
                    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] p-3 dark:border-emerald-400/20 dark:bg-emerald-400/[0.05]">
                      <p className="text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                        Established
                      </p>
                      <ul className="mt-1.5 space-y-1.5">
                        {thread.synthesis.established.map((item, index) => (
                          <li key={index} className="flex items-start gap-2 text-sm text-foreground">
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {thread.synthesis.openQuestions.length > 0 ? (
                    <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] p-3 dark:border-amber-400/20 dark:bg-amber-400/[0.05]">
                      <p className="text-xs font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                        Open questions
                      </p>
                      <ul className="mt-1.5 space-y-1.5">
                        {thread.synthesis.openQuestions.map((item, index) => (
                          <li key={index} className="flex items-start gap-2 text-sm text-foreground">
                            <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Ask something below to get this thread started.</p>
          )}
        </div>

        {thread.turns.length > 0 ? <ThreadGlossary turns={thread.turns} /> : null}

        <FollowUpAskBox
          thread={thread}
          personalDomains={personalDomains}
          vaultOwnerToken={vaultOwnerToken}
          onAnswered={(query, answer, sources, keyTerms, comparisons, paperSearchQuery) =>
            handleFollowUpAnswered(thread, query, answer, sources, keyTerms, comparisons, paperSearchQuery)
          }
        />

        {thread.turns.length > 0 ? (
          <div className="space-y-4">
            {thread.turns
              .slice()
              .reverse()
              .map((turn, index) => {
                const turnRelative = formatRelativeTime(turn.createdAt);
                return (
                  <div key={index} className="space-y-2.5">
                    <div className="flex items-start gap-2.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <User className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm bg-muted/60 px-3.5 py-2.5">
                        <p className="text-sm text-foreground">{turn.query}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300">
                        <Sparkles className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-violet-500/15 bg-violet-500/[0.03] px-3.5 py-2.5 dark:border-violet-400/15">
                        <ChapteredAnswer text={turn.answer} />
                        <ComparisonBars items={turn.comparisons} />
                        <KeyTermChips items={turn.keyTerms} />
                        {turn.sources.length > 0 ? (
                          <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-violet-500/10 pt-2.5">
                            {turn.sources.map((source) => (
                              <a
                                key={source.url}
                                href={source.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-card px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-violet-500/40 hover:text-foreground"
                              >
                                {source.title}
                                <ExternalLink className="h-3 w-3" aria-hidden />
                              </a>
                            ))}
                          </div>
                        ) : null}
                        {turnRelative ? (
                          <p className="mt-1.5 text-[11px] text-muted-foreground/70">{turnRelative}</p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        ) : null}

        <div className="rounded-xl border border-border/60 bg-card/85 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-base font-semibold text-foreground">
              Traced papers <span className="text-sm font-normal text-muted-foreground">({thread.tracedPapers.length})</span>
            </p>
            <Link href={buildSageCitationsRoute(thread.entityId)}>
              <Button size="sm" variant="outline">
                <GitBranch className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                Trace a paper
              </Button>
            </Link>
          </div>
          {thread.tracedPapers.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No papers traced yet for this thread.</p>
          ) : (
            <div className="mt-3 space-y-3">
              {thread.tracedPapers.length > 1 ? (
                <SageComparisonChart
                  unit="citations"
                  items={thread.tracedPapers.map((paper) => ({
                    label: paper.title,
                    value: paper.citedByCount,
                    unit: "citations",
                  }))}
                />
              ) : null}
              {thread.tracedPapers.map((paper) => (
                <div
                  key={paper.id}
                  className="group relative rounded-lg border border-border/50 bg-background/60 p-3 transition-colors hover:border-violet-500/40"
                >
                  <button
                    type="button"
                    onClick={() => void handleRemoveTracedPaper(thread.entityId, paper.id)}
                    className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={`Remove "${paper.title}" from traced papers`}
                    title="Remove from traced papers"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <Link
                    href={buildSageCitationsRoute(thread.entityId, { workId: paper.id, title: paper.title })}
                    className="block pr-6"
                  >
                    <p className="text-sm text-foreground">{paper.title}</p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {paper.year || "Year unknown"}
                      <CitationChip count={paper.citedByCount} />
                      <TopicChip topic={paper.topic} />
                    </p>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const activeThreads = threads.filter((t) => t.status === "active");

  return (
    <div className="space-y-4">
      <NewThreadBox
        personalDomains={personalDomains}
        vaultOwnerToken={vaultOwnerToken}
        onCreate={handleThreadCreated}
      />

      {activeThreads.length === 0 ? (
        <Empty className="border-violet-500/20 bg-violet-500/[0.03] dark:border-violet-400/20 dark:bg-violet-400/[0.03]">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-violet-500/10 text-violet-700 dark:text-violet-300">
              <FlaskConical className="size-6" aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No research threads yet</EmptyTitle>
            <EmptyDescription>
              Ask something above to start Sage&apos;s first ongoing investigation.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {activeThreads.map((thread) => {
            const relative = formatRelativeTime(thread.updatedAt);
            return (
              <button
                key={thread.entityId}
                type="button"
                onClick={() => setView({ mode: "detail", threadId: thread.entityId })}
                className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/85 p-4 text-left shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition-colors hover:border-violet-500/40"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-700 dark:text-violet-300">
                    <FlaskConical className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold leading-snug text-foreground">{thread.title}</p>
                    {relative ? <p className="mt-0.5 text-xs text-muted-foreground/70">Updated {relative}</p> : null}
                  </div>
                </div>
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {thread.synthesis?.summary || "Ask something to get started."}
                </p>
                <div className="mt-auto flex items-center gap-3 border-t border-border/50 pt-2.5 text-xs text-muted-foreground/80">
                  <span className="inline-flex items-center gap-1">
                    <MessageSquare className="h-3 w-3" aria-hidden />
                    {thread.turns.length} question{thread.turns.length === 1 ? "" : "s"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="h-3 w-3" aria-hidden />
                    {thread.tracedPapers.length} traced
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

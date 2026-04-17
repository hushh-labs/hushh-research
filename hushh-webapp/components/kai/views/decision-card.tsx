"use client";

import { useMemo } from "react";
import { useTheme } from "next-themes";
import {
  Card as MorphyCard,
  CardContent as MorphyCardContent,
  CardHeader as MorphyCardHeader,
  CardTitle as MorphyCardTitle,
} from "@/lib/morphy-ux/card";
import {
  Zap,
  ExternalLink,
  Shield,
  BarChart3,
  TrendingUp,
  TrendingDown,
  Scale,
  FileText,
  Link2,
  Target,
  Crown,
  Star,
  Trophy,
  Medal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  LabelList, // Added LabelList
  Label,
} from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Icon } from "@/lib/morphy-ux/ui";
import { toInvestorDecisionLabel } from "@/lib/copy/investor-language";

// ============================================================================
// Types
// ============================================================================

export interface DecisionResult {
  ticker: string;
  decision: "buy" | "hold" | "reduce" | string;
  confidence: number;
  consensus_reached: boolean;
  final_statement: string;
  short_recommendation?: string;
  analysis_degraded?: boolean;
  degraded_agents?: string[];
  stream_id?: string;
  llm_calls_count?: number;
  provider_calls_count?: number;
  retry_counts?: Record<string, number>;
  analysis_mode?: string;
  agent_votes?: Record<string, string>;
  dissenting_opinions?: string[];
  // Enriched data
  fundamental_summary?: string;
  sentiment_summary?: string;
  valuation_summary?: string;
  raw_card?: {
    fundamental_insight?: {
      summary?: string;
      business_moat?: string;
      financial_resilience?: string;
      growth_efficiency?: string;
      bull_case?: string;
      bear_case?: string;
    };
    quant_metrics?: Record<string, unknown>;
    key_metrics?: {
      fundamental?: Record<string, unknown>;
      sentiment?: {
        sentiment_score?: number;
        catalyst_count?: number;
      };
      valuation?: Record<string, unknown>;
    };
    all_sources?: string[];
    pick_source?: string;
    pick_source_label?: string;
    pick_source_kind?: string;
    structured_sources?: Array<{
      label?: string;
      url?: string | null;
      kind?: string;
      paper_title?: string;
    }>;
    risk_persona_alignment?: string;
    debate_digest?: string;
    consensus_reached?: boolean;
    dissenting_opinions?: string[];
    price_targets?: Record<string, number>;
    debate_highlights?: Array<{
      type?: string;
      agent?: string;
      content?: string;
      classification?: string;
      confidence?: number;
      magnitude?: string;
      score?: number;
      source?: string;
    }>;
    pkm_context?: {
      risk_profile?: string;
      preferences?: Record<string, unknown>;
      holdings_count?: number;
      portfolio_allocation?: Record<string, unknown>;
      has_domain_summaries?: boolean;
    };
    renaissance_context?: {
      tier?: string;
      tier_description?: string;
      conviction_weight?: number;
      investment_thesis?: string;
      fcf_billions?: number;
      sector?: string;
      sector_peers?: string[];
      recommendation_bias?: string;
      is_investable?: boolean;
      is_avoid?: boolean;
      avoid_reason?: string;
      screening_criteria?: string;
    };
    alphaagents_trace?: {
      paper?: string;
      paper_title?: string;
      paper_url?: string;
      protocol?: string;
      rounds_executed?: number;
      turns_per_agent?: number;
      consensus_method?: string;
      consensus_threshold?: number;
      consensus_reached?: boolean;
    };
    llm_synthesis?: {
      thesis?: string;
      key_drivers?: string[];
      key_risks?: string[];
      action_plan?: string[];
      watchlist_triggers?: string[];
      horizon_fit?: string;
      error?: string;
      fallback?: boolean;
    };
    short_recommendation?: string;
    analysis_degraded?: boolean;
    degraded_agents?: string[];
    stream_diagnostics?: {
      stream_id?: string;
      llm_calls_count?: number;
      provider_calls_count?: number;
      retry_counts?: Record<string, number>;
      analysis_mode?: string;
    };
    market_snapshot?: {
      last_price?: number | null;
      change_pct?: number | null;
      observed_at?: string | null;
      source?: string;
    };
    context_integrity?: {
      pkm_context_present?: boolean;
      renaissance_context_present?: boolean;
      missing_requirements?: string[];
    };
    renaissance_comparison?: {
      status?: "investable" | "avoid" | "outside_universe" | "unknown";
      tier?: string | null;
      is_investable?: boolean;
      is_avoid?: boolean;
      comparison_label?: string;
      recommendation_bias?: string;
    };
    // Renaissance Data (New)
    renaissance_tier?: "ACE" | "KING" | "QUEEN" | "JACK";
    renaissance_score?: number;
  };
}

// ============================================================================
// Source URL Helpers
// ============================================================================

type StructuredSource = {
  label: string;
  url: string | null;
  kind: string;
  paperTitle?: string;
};

function parseSourceUrl(source: string): { text: string; url: string | null } {
  const normalized = source.trim();
  const lower = normalized.toLowerCase();
  const urlMatch = source.match(/https?:\/\/[^\s)]+/);
  if (urlMatch) {
    return { text: source.replace(urlMatch[0], "").trim() || urlMatch[0], url: urlMatch[0] };
  }
  if (
    lower.includes("alphaagents") ||
    lower.includes("arxiv:2508.11152") ||
    lower.includes("2508.11152")
  ) {
    return {
      text: "AlphaAgents paper",
      url: "https://arxiv.org/pdf/2508.11152",
    };
  }
  return { text: source, url: null };
}

function normalizeSource(source: string | StructuredSource): StructuredSource {
  if (typeof source !== "string") {
    const label = String(source.label || "").trim();
    if (label) {
      return {
        label,
        url: typeof source.url === "string" && source.url.trim() ? source.url.trim() : null,
        kind: String(source.kind || "reference").trim() || "reference",
        paperTitle: source.paperTitle,
      };
    }
  }
  const raw = typeof source === "string" ? source : "";
  const { text, url } = parseSourceUrl(raw);
  return {
    label: text || raw,
    url,
    kind: "reference",
  };
}

function resolvePickSourceLabel(rawCard: DecisionResult["raw_card"]): string | null {
  if (!rawCard || typeof rawCard !== "object") return null;
  const explicit =
    typeof rawCard.pick_source_label === "string" ? rawCard.pick_source_label.trim() : "";
  if (explicit) return explicit;
  const sourceId = typeof rawCard.pick_source === "string" ? rawCard.pick_source.trim() : "";
  const kind = typeof rawCard.pick_source_kind === "string" ? rawCard.pick_source_kind.trim() : "";
  if (sourceId === "default" || kind === "default") {
    return "Default list";
  }
  if (sourceId.startsWith("ria:") || kind === "ria") {
    return "Connected advisor list";
  }
  return sourceId || null;
}

function SourceLink({ source }: { source: StructuredSource }) {
  const normalized = normalizeSource(source);
  const text = normalized.paperTitle
    ? `${normalized.label}`
    : normalized.label;
  const url = normalized.url;
  return (
    <a
      href={url!}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1 truncate border-l-2 border-primary/20 pl-2 text-[10px] text-primary/80 transition-colors hover:text-primary"
    >
      <Icon icon={Link2} size={10} className="shrink-0" />
      <span className="truncate">{text || url}</span>
    </a>
  );
}

function renderCompactTooltip(label: string, value: string, context?: string) {
  return (
    <div className="flex min-w-[9rem] flex-col gap-1">
      <span className="text-[11px] font-semibold text-foreground">{label}</span>
      <span className="text-sm font-semibold tracking-tight text-foreground">{value}</span>
      {context ? (
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {context}
        </span>
      ) : null}
    </div>
  );
}

function ChartPanel({
  title,
  icon,
  accentClassName,
  children,
}: {
  title: string;
  icon: typeof TrendingUp;
  accentClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[1.35rem] border border-border/60 bg-[color:var(--app-card-surface-default-solid)] p-4 text-foreground md:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Icon icon={icon} size="xs" className={cn("text-sky-700 dark:text-sky-300", accentClassName)} />
        <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-foreground/80 dark:text-foreground/78">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function inferOwnedPosition(result: DecisionResult): boolean | null {
  const rawCard = result.raw_card;
  if (!rawCard || typeof rawCard !== "object") return null;
  const candidateFlags = [
    (rawCard as Record<string, unknown>).owns_position,
    (rawCard as Record<string, unknown>).is_position_owned,
    (rawCard as Record<string, unknown>).in_portfolio,
  ];
  for (const value of candidateFlags) {
    if (typeof value === "boolean") return value;
  }
  return null;
}

function normalizeSentimentPercent(raw: unknown): number | null {
  const numeric =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
      ? Number.parseFloat(raw.replace(/%/g, "").trim())
      : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  // Support both [-1, 1] and [-100, 100] score conventions.
  const asPercent = Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
  return Math.max(-100, Math.min(100, asPercent));
}

// ============================================================================
// Chart Sub-Components
// ============================================================================

const RESULT_CHART_COLORS = {
  primary: "rgb(14 165 233)",
  positive: "rgb(16 185 129)",
  neutral: "rgb(245 158 11)",
  accent: "rgb(56 189 248)",
  negative: "rgb(239 68 68)",
} as const;

const DETAIL_PANEL_CLASSNAME =
  "rounded-2xl border border-border/60 bg-[color:var(--app-card-surface-default-solid)] p-4";
const DETAIL_PANEL_COMPACT_CLASSNAME =
  "rounded-xl border border-border/50 bg-[color:var(--app-card-surface-default-solid)] p-3";
const DETAIL_PANEL_EMPHASIS_CLASSNAME =
  "rounded-2xl border border-border/60 bg-[color:var(--app-card-surface-compact)] p-5";
const DETAIL_LABEL_CLASSNAME =
  "text-[10px] font-semibold uppercase tracking-widest text-foreground/72 dark:text-foreground/76";

const voteChartConfig = {
  bullish: {
    label: "Bullish",
    color: RESULT_CHART_COLORS.positive,
  },
  neutral: {
    label: "Neutral",
    color: RESULT_CHART_COLORS.neutral,
  },
  bearish: {
    label: "Bearish",
    color: RESULT_CHART_COLORS.negative,
  },
} satisfies ChartConfig;

function AgentVoteBar({ result }: { result: DecisionResult }) {
  const votes = result.agent_votes || {};
  const entries = Object.entries(votes);
  if (entries.length === 0) return null;

  const toScore = (vote: string): number => {
    const normalized = vote.toLowerCase();
    if (normalized === "buy" || normalized === "bullish" || normalized === "undervalued") return 1;
    if (normalized === "reduce" || normalized === "sell" || normalized === "bearish") return -1;
    return 0;
  };
  const data = entries.map(([agent, vote]) => {
    const score = toScore(vote);
    return {
      agent: agent.charAt(0).toUpperCase() + agent.slice(1),
      vote: vote.toUpperCase(),
      bullish: score > 0 ? 1 : 0,
      neutral: score === 0 ? 1 : 0,
      bearish: score < 0 ? 1 : 0,
    };
  });

  const renderVoteTooltip = ({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: Array<{ payload?: { agent?: string; vote?: string; bullish?: number; neutral?: number; bearish?: number } }>;
  }) => {
    if (!active || !payload?.length) return null;
    const activeItem =
      payload.find((entry) => {
        const row = entry?.payload;
        return Boolean(row && ((row.bullish || 0) > 0 || (row.neutral || 0) > 0 || (row.bearish || 0) > 0));
      })?.payload || payload[0]?.payload;
    if (!activeItem) return null;
    return (
      <div className="rounded-lg border border-border/60 bg-background/95 px-3 py-2 shadow-xl backdrop-blur-sm">
        {renderCompactTooltip(activeItem.agent || "Agent", activeItem.vote || "View", "Vote")}
      </div>
    );
  };

  return (
    <ChartPanel title="Agent votes" icon={Scale} accentClassName="text-sky-700 dark:text-sky-300">
      <ChartContainer config={voteChartConfig} className="h-[240px] w-full">
        <BarChart
          accessibilityLayer
          data={data}
          layout="vertical"
          margin={{ top: 8, right: 16, left: 10, bottom: 8 }}
        >
          <CartesianGrid horizontal={false} strokeDasharray="3 3" strokeOpacity={0.55} />
          <XAxis
            type="number"
            domain={[0, 1]}
            axisLine={false}
            tickLine={false}
            hide
          />
          <YAxis
            type="category"
            dataKey="agent"
            width={106}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: "hsl(var(--foreground))" }}
          />
          <ChartTooltip cursor={false} content={renderVoteTooltip} />
          <ChartLegend content={<ChartLegendContent className="text-[11px] font-medium text-foreground/80 dark:text-foreground/80" />} />
          <Bar dataKey="bullish" stackId="vote" fill="var(--color-bullish)" radius={[4, 0, 0, 4]} barSize={14} />
          <Bar dataKey="neutral" stackId="vote" fill="var(--color-neutral)" barSize={14} />
          <Bar dataKey="bearish" stackId="vote" fill="var(--color-bearish)" radius={[0, 4, 4, 0]} barSize={14} />
        </BarChart>
      </ChartContainer>
    </ChartPanel>
  );
}

const consensusChartConfig = {
  agree: {
    label: "Agree",
    color: RESULT_CHART_COLORS.positive,
  },
  dissent: {
    label: "Dissent",
    color: RESULT_CHART_COLORS.negative,
  },
} satisfies ChartConfig;

function ConsensusDonut({ result }: { result: DecisionResult }) {
  const votes = result.agent_votes ? Object.values(result.agent_votes) : [];
  if (votes.length === 0) return null;

  const majority = result.decision.toLowerCase();
  const agreeCount = votes.filter((v) => String(v).toLowerCase() === majority).length;
  const dissentCount = votes.length - agreeCount;

  const data = [
    { name: "Agree", value: agreeCount, fill: consensusChartConfig.agree.color },
    { name: "Dissent", value: dissentCount, fill: consensusChartConfig.dissent.color },
  ].filter((d) => d.value > 0);
  const totalVotes = Math.max(1, votes.length);
  const agreePct = Math.round((agreeCount / totalVotes) * 100);

  return (
    <ChartPanel title="Consensus" icon={Target} accentClassName="text-amber-700 dark:text-amber-300">
      <div className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-2xl font-black tracking-tight text-foreground">{agreePct}%</p>
            <p className="text-xs text-muted-foreground">Agents align with the final call</p>
          </div>
          <div className="rounded-xl border border-amber-500/15 bg-amber-500/[0.08] px-3 py-2 text-right">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">
              Split
            </p>
            <p className="text-sm font-semibold text-foreground">
              {agreeCount} agree / {dissentCount} dissent
            </p>
          </div>
        </div>
        <div className="overflow-hidden rounded-full border border-border/50 bg-muted/40">
          <div className="flex h-3 w-full">
            <div
              className="h-full bg-emerald-500/85"
              style={{ width: `${(agreeCount / totalVotes) * 100}%` }}
            />
            <div
              className="h-full bg-rose-500/75"
              style={{ width: `${(dissentCount / totalVotes) * 100}%` }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
          {data.map((d) => (
            <div key={d.name} className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: d.name === "Agree" ? consensusChartConfig.agree.color : consensusChartConfig.dissent.color }}
              />
              <span>
                {d.name} ({d.value})
              </span>
            </div>
          ))}
        </div>
      </div>
    </ChartPanel>
  );
}

const barChartConfig = {
  value: {
    label: "Value",
    color: RESULT_CHART_COLORS.primary,
  },
  negative: {
    label: "Negative",
    color: RESULT_CHART_COLORS.negative,
  },
  scenario: {
    label: "Scenario",
    color: RESULT_CHART_COLORS.neutral,
  },
} satisfies ChartConfig;

function QuantMetricsBarChart({ metrics }: { metrics: Record<string, unknown> }) {
  const compactMetricLabel = (value: string) => {
    const text = String(value || "");
    if (text.length <= 20) return text;
    return `${text.slice(0, 19)}…`;
  };

  const data = useMemo(() => {
    return Object.entries(metrics)
      .filter((entry): entry is [string, number] => {
        const value = entry[1];
        return typeof value === "number" && value !== 0 && !Number.isNaN(value);
      })
      .slice(0, 6)
      .map(([key, value]) => ({
        name: key.replace(/_/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase()),
        value: Math.abs(value) >= 1e9 ? value / 1e9 : Math.abs(value) >= 1e6 ? value / 1e6 : value,
        isNegative: value < 0,
        fill: value < 0 ? "var(--color-negative)" : "var(--color-value)",
      }));
  }, [metrics]);

  if (data.length === 0) return null;

  return (
    <ChartPanel title="Valuation & fundamentals" icon={BarChart3}>
      <ChartContainer config={barChartConfig} className="h-[210px] w-full">
        <BarChart
          accessibilityLayer
          data={data}
          layout="vertical"
          margin={{ left: 12, right: 36, top: 8, bottom: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.45} />
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="name"
            width={132}
            tickFormatter={(value) => compactMetricLabel(String(value))}
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
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
                  return renderCompactTooltip(
                    payload?.name || "Metric",
                    Number(value).toLocaleString(),
                    "Metric"
                  );
                }}
              />
            }
          />
          <Bar
            dataKey="value"
            fill="var(--color-value)"
            radius={[0, 4, 4, 0]}
            barSize={12}
          >
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.fill} />
            ))}
            <LabelList dataKey="value" position="right" fontSize={9} fill="hsl(var(--foreground))" formatter={(val: number) => val.toFixed(1)} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartPanel>
  );
}

function PriceTargetsChart({ targets }: { targets: Record<string, number> }) {
  const { resolvedTheme } = useTheme();
  const data = Object.entries(targets)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .slice(0, 4)
    .map(([key, value]) => ({
      scenario: key.replace(/_/g, " ").replace(/\b\w/g, (letter: string) => letter.toUpperCase()),
      value: value as number,
    }));

  if (data.length < 2) return null;

  const chartTextColor =
    resolvedTheme === "dark" ? "rgb(244 244 245)" : "rgb(15 23 42)";
  const chartAxisColor =
    resolvedTheme === "dark" ? "rgb(161 161 170)" : "rgb(71 85 105)";

  return (
    <ChartPanel title="Price scenarios" icon={TrendingUp} accentClassName="text-emerald-700 dark:text-emerald-300">
      <ChartContainer config={barChartConfig} className="h-[225px] w-full">
        <BarChart accessibilityLayer data={data} margin={{ top: 12, right: 12, left: 10, bottom: 12 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" strokeOpacity={0.55} />
          <XAxis
            dataKey="scenario"
            tick={{ fontSize: 10, fill: chartAxisColor }}
            axisLine={false}
            tickLine={false}
            tickMargin={8}
          />
          <YAxis
            tick={{ fontSize: 10, fill: chartAxisColor }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value) => `$${Number(value).toFixed(0)}`}
            width={56}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value, _name, item) => {
                  const payload = item?.payload as { scenario?: string } | undefined;
                  return renderCompactTooltip(
                    payload?.scenario || "Scenario",
                    `$${Number(value).toFixed(2)}`,
                    "Target"
                  );
                }}
              />
            }
          />
          <Bar dataKey="value" radius={8} fill="var(--color-scenario)">
            <LabelList
              dataKey="value"
              position="top"
              fontSize={10}
              fill={chartTextColor}
              formatter={(value: number) => `$${value.toFixed(2)}`}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartPanel>
  );
}

// NEW: Confidence Gauge (Semi-circle Pie)
function ConfidenceGauge({ confidence }: { confidence: number }) {
  const normalized = Number.isFinite(confidence)
    ? Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence))
    : 0;
  const score = Math.round(normalized * 100);
  const tone =
    score >= 70
      ? RESULT_CHART_COLORS.positive
      : score >= 40
      ? RESULT_CHART_COLORS.primary
      : RESULT_CHART_COLORS.negative;
  const chartData = [
    { key: "score", name: "Confidence", value: score, fill: "var(--color-score)" },
    { key: "remaining", name: "Remaining", value: Math.max(0, 100 - score), fill: "var(--color-remaining)" },
  ];
  const confidenceChartConfig = {
    score: {
      label: "Confidence",
      color: tone,
    },
    remaining: {
      label: "Remaining",
      color: "hsl(var(--muted))",
    },
  } satisfies ChartConfig;

  return (
    <div className="w-full">
      <ChartContainer config={confidenceChartConfig} className="mx-auto aspect-square max-h-[170px] w-full max-w-[210px]">
        <PieChart>
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent hideLabel nameKey="name" />}
          />
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="name"
            innerRadius={52}
            outerRadius={74}
            strokeWidth={4}
          >
            <Cell fill="var(--color-score)" />
            <Cell fill="var(--color-remaining)" />
            <Label
              content={({ viewBox }) => {
                if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                  return (
                    <text
                      x={viewBox.cx}
                      y={viewBox.cy}
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      <tspan
                        x={viewBox.cx}
                        y={viewBox.cy}
                        className="fill-foreground text-3xl font-black tracking-tighter"
                      >
                        {score}%
                      </tspan>
                      <tspan
                        x={viewBox.cx}
                        y={(viewBox.cy || 0) + 18}
                        className="fill-muted-foreground text-[10px] uppercase tracking-wider font-semibold"
                      >
                        Confidence
                      </tspan>
                    </text>
                  );
                }
                return null;
              }}
            />
          </Pie>
        </PieChart>
      </ChartContainer>
    </div>
  );
}

// NEW: Renaissance Badge
function RenaissanceBadge({ tier, score }: { tier: "ACE" | "KING" | "QUEEN" | "JACK"; score?: number }) {
  const badgeConfig = {
    ACE: {
      color: "bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-950/30 dark:text-fuchsia-400 dark:border-fuchsia-800",
      icon: <Icon icon={Crown} size="xs" className="fill-current" />,
      label: "Renaissance Ace",
    },
    KING: {
      color: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800",
      icon: <Icon icon={Trophy} size="xs" className="fill-current" />,
      label: "Renaissance King",
    },
    QUEEN: {
      color: "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-400 dark:border-violet-800",
      icon: <Icon icon={Star} size="xs" className="fill-current" />,
      label: "Renaissance Queen",
    },
    JACK: {
      color: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800",
      icon: <Icon icon={Medal} size="xs" className="fill-current" />,
      label: "Renaissance Jack",
    },
  };

  const config = badgeConfig[tier];

  return (
    <div className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-bold uppercase tracking-wider shadow-sm", config.color)}>
      {config.icon}
      {config.label}
      {score && <span className="ml-1 opacity-70">| {score.toFixed(0)}</span>}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function DecisionCard({ result }: { result: DecisionResult }) {
  const ownsPosition = useMemo(() => inferOwnedPosition(result), [result]);
  const decisionPresentation = useMemo(
    () => toInvestorDecisionLabel(result.decision, ownsPosition),
    [ownsPosition, result.decision]
  );
  const isBuy = decisionPresentation.tone === "positive";
  const isReduce = decisionPresentation.tone === "negative";

  const rawCard = result.raw_card;
  const pickSourceDisplayLabel = resolvePickSourceLabel(rawCard);
  const sources = useMemo(() => {
    const sourceList: StructuredSource[] = [];
    for (const source of rawCard?.structured_sources || []) {
      if (!source || typeof source !== "object") continue;
      const label = String(source.label || "").trim();
      if (!label) continue;
      sourceList.push({
        label,
        url: typeof source.url === "string" && source.url.trim() ? source.url.trim() : null,
        kind: String(source.kind || "reference").trim() || "reference",
        paperTitle:
          typeof source.paper_title === "string" && source.paper_title.trim()
            ? source.paper_title.trim()
            : undefined,
      });
    }
    for (const source of rawCard?.all_sources || []) {
      if (typeof source === "string" && source.trim()) {
        sourceList.push(normalizeSource(source.trim()));
      }
    }
    for (const highlight of rawCard?.debate_highlights || []) {
      if (typeof highlight?.source === "string" && highlight.source.trim()) {
        sourceList.push(normalizeSource(highlight.source.trim()));
      }
    }

    const deduped: StructuredSource[] = [];
    const seen = new Set<string>();
    for (const value of sourceList) {
      if (!value.url) continue;
      const key = `${value.label.toLowerCase()}::${(value.url || "").toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(value);
    }
    return deduped;
  }, [rawCard]);
  const hasQuantMetrics = rawCard?.quant_metrics && Object.keys(rawCard.quant_metrics).filter(
    (k) => rawCard.quant_metrics![k] !== null && rawCard.quant_metrics![k] !== undefined && typeof rawCard.quant_metrics![k] !== "object"
  ).length > 0;

  // Fallback for empty/missing decision to prevent layout shift
  const safeDecision = decisionPresentation.label || "REVIEW";
  const safeConfidence = result.confidence || 0;
  const llmSynthesis = rawCard?.llm_synthesis;
  const synthesisDrivers = (llmSynthesis?.key_drivers || []).filter(Boolean).slice(0, 6);
  const synthesisRisks = (llmSynthesis?.key_risks || []).filter(Boolean).slice(0, 6);
  const synthesisActionPlan = (llmSynthesis?.action_plan || []).filter(Boolean).slice(0, 5);
  const synthesisTriggers = (llmSynthesis?.watchlist_triggers || []).filter(Boolean).slice(0, 6);
  const debateHighlights = (rawCard?.debate_highlights || [])
    .filter((entry) => Boolean(entry?.content))
    .slice(0, 12);

  return (
    <MorphyCard showRipple={false}>
      <MorphyCardHeader>
          <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon icon={Zap} size="md" className="text-primary" />
            <MorphyCardTitle>Final Recommendation</MorphyCardTitle>
          </div>
          <Badge
            variant="outline"
            className="text-[10px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
          >
            COMPLETE
          </Badge>
        </div>
      </MorphyCardHeader>
      
      <MorphyCardContent>
        <div className="space-y-6">
        
        {/* HERO SECTION: Decision + Badges */}
        <div className="flex flex-col items-center gap-4">
            
            {/* Renaissance Badge - Positioned prominently if exists */}
            {rawCard?.renaissance_tier && (
                <div className="animate-in fade-in slide-in-from-top-2  delay-100">
                    <RenaissanceBadge tier={rawCard.renaissance_tier} score={rawCard.renaissance_score} />
                </div>
            )}

            {/* Main Decision Pill */}
            <div
                className={cn(
                "px-10 py-5 rounded-2xl border-2 text-4xl font-black uppercase tracking-tighter shadow-xl backdrop-blur-md transform transition-all duration-300 hover:scale-[1.02]",
                isBuy
                    ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-500 shadow-emerald-500/10"
                    : isReduce
                    ? "bg-red-500/10 border-red-500/20 text-red-500 shadow-red-500/10"
                    : "bg-blue-500/10 border-blue-500/20 text-blue-500 shadow-blue-500/10"
                )}
            >
                {safeDecision}
            </div>

            {/* Confidence Gauge - Replacing Linear Progress */}
            <ConfidenceGauge confidence={safeConfidence} />
        </div>

        <Separator className="bg-primary/10" />

        {pickSourceDisplayLabel ? (
          <div className="flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-border/60 bg-[color:var(--app-card-surface-default-solid)] px-4 py-3">
            <Badge variant="outline" className="border-sky-500/25 bg-transparent text-sky-700 dark:text-sky-300">
              Debate source
            </Badge>
            <p className="text-sm font-medium text-foreground">{pickSourceDisplayLabel}</p>
          </div>
        ) : null}

        {/* DATA VISUALIZATION GRID */}
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 md:gap-6">
          <AgentVoteBar result={result} />
          {rawCard?.price_targets && Object.keys(rawCard.price_targets).length > 1 ? (
               <PriceTargetsChart targets={rawCard.price_targets} />
          ) : hasQuantMetrics && rawCard?.quant_metrics ? (
               <QuantMetricsBarChart metrics={rawCard.quant_metrics} />
          ) : (
               <ConsensusDonut result={result} />
          )}
        </div>

        {/* KEY INSIGHTS SECTION */}
        <div className="space-y-3">
            {/* Risk Persona Alignment */}
            {rawCard?.risk_persona_alignment && (
            <div className={DETAIL_PANEL_CLASSNAME}>
                <div className="flex items-center gap-2 mb-2">
                <Icon icon={Shield} size="sm" className="text-primary" />
                <span className={DETAIL_LABEL_CLASSNAME}>Risk Alignment</span>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{rawCard.risk_persona_alignment}</p>
            </div>
            )}

            {/* Key Takeaway - Highlight the most important insight */}
            {rawCard?.fundamental_insight?.summary && (
            <div className={cn(DETAIL_PANEL_EMPHASIS_CLASSNAME, "relative overflow-hidden")}>
                <div className="absolute top-0 right-0 p-4 opacity-[0.035]">
                    <Icon icon={Zap} size={96} className="rotate-12" />
                </div>
                <div className="relative z-10">
                    <div className="flex items-center gap-2 mb-2">
                    <Icon icon={Zap} size="sm" className="text-primary" />
                    <span className={DETAIL_LABEL_CLASSNAME}>Key Takeaway</span>
                    </div>
                    <p className="text-sm font-semibold leading-relaxed text-foreground/90">{rawCard.fundamental_insight.summary}</p>
                </div>
            </div>
            )}
        </div>

        {/* SECONDARY METRICS GRID */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Business Moat */}
            {rawCard?.fundamental_insight?.business_moat && (
            <div className={DETAIL_PANEL_CLASSNAME}>
                <div className="flex items-center gap-2 mb-2">
                <Icon icon={Shield} size="xs" className="text-sky-700 dark:text-sky-300" />
                <span className={DETAIL_LABEL_CLASSNAME}>Moat</span>
                </div>
                <p className="text-xs text-muted-foreground">{rawCard.fundamental_insight.business_moat}</p>
            </div>
            )}
            
            {/* Sentiment Gauge Card */}
            {rawCard?.key_metrics?.sentiment?.sentiment_score !== undefined && (
            <div className={DETAIL_PANEL_CLASSNAME}>
                {(() => {
                  const sentimentPct = normalizeSentimentPercent(
                    rawCard.key_metrics?.sentiment?.sentiment_score
                  );
                  if (sentimentPct === null) return null;
                  const progressPct = Math.max(0, Math.min(100, (sentimentPct + 100) / 2));
                  return (
                    <>
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <Icon icon={BarChart3} size="xs" className="text-sky-600 dark:text-sky-300" />
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground/80 dark:text-foreground/80">Sentiment</span>
                    </div>
                    <Badge variant="outline" className="border-border/40 bg-muted/30 text-[10px] font-mono text-foreground/85 dark:text-foreground/85">
                        {sentimentPct >= 0 ? "+" : ""}
                        {sentimentPct.toFixed(0)}%
                    </Badge>
                </div>
                <Progress value={progressPct} className="h-1.5 mb-2" />
                <p className="text-[10px] text-muted-foreground text-center font-medium">
                {sentimentPct > 30 ? "Bullish" : sentimentPct < -30 ? "Bearish" : "Neutral"}
                </p>
                    </>
                  );
                })()}
            </div>
            )}
        </div>

        {/* BULL / BEAR TOGGLES */}
        {(rawCard?.fundamental_insight?.bull_case || rawCard?.fundamental_insight?.bear_case) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {rawCard.fundamental_insight.bull_case && (
                <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                <div className="flex items-center gap-2 mb-2">
                    <Icon icon={TrendingUp} size="xs" className="text-emerald-600 dark:text-emerald-400" />
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-700 dark:text-emerald-300">Bull Case</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{rawCard.fundamental_insight.bull_case}</p>
                </div>
            )}
            {rawCard.fundamental_insight.bear_case && (
                <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4">
                <div className="flex items-center gap-2 mb-2">
                    <Icon icon={TrendingDown} size="xs" className="text-rose-600 dark:text-rose-400" />
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-rose-700 dark:text-rose-300">Bear Case</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{rawCard.fundamental_insight.bear_case}</p>
                </div>
            )}
            </div>
        )}

        {/* FINANCIAL RESILIENCE & GROWTH */}
        {(rawCard?.fundamental_insight?.financial_resilience || rawCard?.fundamental_insight?.growth_efficiency) && (
          <div className="grid grid-cols-2 gap-3">
            {rawCard.fundamental_insight.financial_resilience && (
              <div className={DETAIL_PANEL_COMPACT_CLASSNAME}>
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-foreground/68 dark:text-foreground/72">Resilience</p>
                <p className="text-xs font-medium">{rawCard.fundamental_insight.financial_resilience}</p>
              </div>
            )}
            {rawCard.fundamental_insight.growth_efficiency && (
              <div className={DETAIL_PANEL_COMPACT_CLASSNAME}>
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-foreground/68 dark:text-foreground/72">Growth Eff.</p>
                <p className="text-xs font-medium">{rawCard.fundamental_insight.growth_efficiency}</p>
              </div>
            )}
          </div>
        )}

        {/* FINAL STATEMENT */}
        <div className={DETAIL_PANEL_EMPHASIS_CLASSNAME}>
            <div className="flex items-center gap-2 mb-2 opacity-50">
                <Icon icon={FileText} size="xs" />
                <span className={DETAIL_LABEL_CLASSNAME}>Verdict Rationale</span>
            </div>
            <p className="text-sm font-medium leading-relaxed">{rawCard?.debate_digest || result.final_statement}</p>
        </div>

        {/* LLM SYNTHESIS */}
        {(llmSynthesis?.thesis || llmSynthesis?.horizon_fit || llmSynthesis?.error) && (
          <div className={cn(DETAIL_PANEL_EMPHASIS_CLASSNAME, "space-y-3")}>
            <div className="flex items-center justify-between gap-2">
              <p className={cn(DETAIL_LABEL_CLASSNAME, "flex items-center gap-1.5")}>
                <Icon icon={Target} size="xs" className="text-primary" />
                Chief Strategist Synthesis
              </p>
              {llmSynthesis?.fallback && (
                <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                  Simplified
                </Badge>
              )}
            </div>
            {llmSynthesis?.thesis && (
              <p className="text-sm leading-relaxed text-foreground/90">{llmSynthesis.thesis}</p>
            )}
            {llmSynthesis?.horizon_fit && (
              <div className="rounded-xl border border-border/50 bg-background/60 p-3">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-foreground/68 dark:text-foreground/72">
                  Horizon Fit
                </p>
                <p className="text-xs text-foreground/80">{llmSynthesis.horizon_fit}</p>
              </div>
            )}
            {llmSynthesis?.error && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Some advanced synthesis context was unavailable in this run.
              </p>
            )}
          </div>
        )}

        {/* DRIVERS + RISKS */}
        {(synthesisDrivers.length > 0 || synthesisRisks.length > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {synthesisDrivers.length > 0 && (
              <div className={DETAIL_PANEL_CLASSNAME}>
                <p className={cn(DETAIL_LABEL_CLASSNAME, "mb-2 flex items-center gap-1.5")}>
                  <Icon icon={TrendingUp} size="xs" className="text-emerald-600 dark:text-emerald-400" />
                  Key Drivers
                </p>
                <ul className="space-y-2">
                  {synthesisDrivers.map((driver, idx) => (
                    <li
                      key={`${driver}-${idx}`}
                      className="text-xs text-muted-foreground pl-3 border-l-2 border-emerald-500/30"
                    >
                      {driver}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {synthesisRisks.length > 0 && (
              <div className={DETAIL_PANEL_CLASSNAME}>
                <p className={cn(DETAIL_LABEL_CLASSNAME, "mb-2 flex items-center gap-1.5")}>
                  <Icon icon={Shield} size="xs" className="text-rose-600 dark:text-rose-400" />
                  Key Risks
                </p>
                <ul className="space-y-2">
                  {synthesisRisks.map((risk, idx) => (
                    <li
                      key={`${risk}-${idx}`}
                      className="text-xs text-muted-foreground pl-3 border-l-2 border-red-500/30"
                    >
                      {risk}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* ACTION PLAN + WATCHLIST */}
        {(synthesisActionPlan.length > 0 || synthesisTriggers.length > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {synthesisActionPlan.length > 0 && (
              <div className={DETAIL_PANEL_CLASSNAME}>
                <p className={cn(DETAIL_LABEL_CLASSNAME, "mb-2 flex items-center gap-1.5")}>
                  <Icon icon={Target} size="xs" className="text-sky-700 dark:text-sky-300" />
                  Action Plan
                </p>
                <ul className="space-y-2">
                  {synthesisActionPlan.map((step, idx) => (
                    <li
                      key={`${step}-${idx}`}
                      className="text-xs text-muted-foreground pl-3 border-l-2 border-blue-500/30"
                    >
                      {step}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {synthesisTriggers.length > 0 && (
              <div className={DETAIL_PANEL_CLASSNAME}>
                <p className={cn(DETAIL_LABEL_CLASSNAME, "mb-2 flex items-center gap-1.5")}>
                  <Icon icon={Zap} size="xs" className="text-amber-600 dark:text-amber-400" />
                  Watchlist Triggers
                </p>
                <ul className="space-y-2">
                  {synthesisTriggers.map((trigger, idx) => (
                    <li
                      key={`${trigger}-${idx}`}
                      className="text-xs text-muted-foreground pl-3 border-l-2 border-amber-500/30"
                    >
                      {trigger}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* DEBATE HIGHLIGHTS */}
        {debateHighlights.length > 0 && (
          <div className={cn(DETAIL_PANEL_CLASSNAME, "space-y-3")}>
            <p className={DETAIL_LABEL_CLASSNAME}>
              Debate Highlights
            </p>
            <div className="max-h-56 overflow-y-auto pr-1 space-y-2">
              {debateHighlights.map((entry, idx) => (
                <div key={`${entry.agent}-${idx}`} className="p-2 rounded-lg border border-border/40 bg-background/40">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {entry.agent || "agent"}
                    </Badge>
                    {entry.type && (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {entry.type.replace(/_/g, " ")}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{entry.content}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Deep Analysis section intentionally removed: debate rounds already surface the agent detail. */}
        
        {/* Consensus Donut - Only show here if QuantMetrics took the main spot */}
        {hasQuantMetrics && rawCard?.quant_metrics && (
             <div className="pt-2">
                <Separator className="bg-primary/5 mb-4" />
                <ConsensusDonut result={result} />
             </div>
        )}

        {/* DISSENT */}
        {result.dissenting_opinions && result.dissenting_opinions.length > 0 && (
          <div className={DETAIL_PANEL_CLASSNAME}>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-foreground/74 dark:text-foreground/76">
              <Icon icon={Scale} size="xs" className="text-amber-600 dark:text-amber-400" />
              Dissenting Opinions
            </p>
            <ul className="space-y-2">
              {result.dissenting_opinions.map((opinion, idx) => (
                <li key={idx} className="text-xs text-muted-foreground pl-3 border-l-2 border-amber-500/30">
                  {opinion}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* SOURCES */}
        {sources.length > 0 && (
          <>
            <Separator className="opacity-30" />
            <div>
              <p className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider">
                <Icon icon={ExternalLink} size="xs" />
                Sources ({sources.length})
              </p>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {sources.map((src, i) => (
                  <SourceLink key={`${src.label}-${src.url || "nolink"}-${i}`} source={src} />
                ))}
              </div>
            </div>
          </>
        )}

        {/* DISCLAIMER */}
        <div className="pt-4">
          <p className="text-[10px] text-muted-foreground/50 text-center leading-relaxed max-w-xs mx-auto">
            Agent Kai is an educational tool and does not constitute investment advice. Always consult a qualified
            financial advisor.
          </p>
        </div>
        </div>
      </MorphyCardContent>
    </MorphyCard>
  );
}

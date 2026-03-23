"use client";

import { useMemo } from "react";
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

const KNOWN_SOURCE_URLS: Record<string, string> = {
  "yahoo finance": "https://finance.yahoo.com",
  "sec edgar": "https://www.sec.gov/cgi-bin/browse-edgar",
  "google finance": "https://www.google.com/finance",
  "bloomberg": "https://www.bloomberg.com",
  "reuters": "https://www.reuters.com",
  "finnhub": "https://finnhub.io",
  "pmp/fmp": "https://site.financialmodelingprep.com/developer/docs",
  "financial modeling prep": "https://site.financialmodelingprep.com/developer/docs",
  "marketwatch": "https://www.marketwatch.com",
  "seeking alpha": "https://seekingalpha.com",
};

function parseSourceUrl(source: string): { text: string; url: string | null } {
  const urlMatch = source.match(/https?:\/\/[^\s)]+/);
  if (urlMatch) {
    return { text: source.replace(urlMatch[0], "").trim() || urlMatch[0], url: urlMatch[0] };
  }
  const lower = source.toLowerCase();
  for (const [key, url] of Object.entries(KNOWN_SOURCE_URLS)) {
    if (lower.includes(key)) {
      return { text: source, url };
    }
  }
  return { text: source, url: null };
}

function SourceLink({ source }: { source: string }) {
  const { text, url } = parseSourceUrl(source);
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[10px] text-primary/80 hover:text-primary truncate pl-2 border-l-2 border-primary/20 flex items-center gap-1 transition-colors"
      >
        <Icon icon={Link2} size={10} className="shrink-0" />
        <span className="truncate">{text || url}</span>
      </a>
    );
  }
  return (
    <p className="text-[10px] text-muted-foreground truncate pl-2 border-l-2 border-primary/20">
      {text}
    </p>
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
  primary: "var(--chart-1)",
  positive: "var(--chart-2)",
  neutral: "var(--chart-4)",
  accent: "var(--chart-3)",
  negative: "var(--chart-5)",
} as const;

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

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Agent Votes
      </p>
      <ChartContainer config={voteChartConfig} className="h-[210px] w-full">
        <BarChart
          accessibilityLayer
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 10, left: 6, bottom: 6 }}
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
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value, _name, item) => {
                  const payload = item?.payload as { agent?: string; vote?: string } | undefined;
                  return (
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Agent Votes
                      </span>
                      <span className="text-xs text-muted-foreground">{payload?.agent || "Agent"}</span>
                      <span className="text-sm font-semibold">{payload?.vote || String(value)}</span>
                    </div>
                  );
                }}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="bullish" stackId="vote" fill="var(--color-bullish)" radius={[4, 0, 0, 4]} barSize={14} />
          <Bar dataKey="neutral" stackId="vote" fill="var(--color-neutral)" barSize={14} />
          <Bar dataKey="bearish" stackId="vote" fill="var(--color-bearish)" radius={[0, 4, 4, 0]} barSize={14} />
        </BarChart>
      </ChartContainer>
    </div>
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

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-center">
        Consensus
      </p>
      <ChartContainer config={consensusChartConfig} className="h-[120px] w-full">
        <PieChart accessibilityLayer>
          <ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel />} />
          <Pie data={data} cx="50%" cy="50%" innerRadius={30} outerRadius={48} dataKey="value" strokeWidth={0}>
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.fill} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <div className="flex justify-center gap-3">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: d.name === "Agree" ? consensusChartConfig.agree.color : consensusChartConfig.dissent.color }}
            />
            {d.name} ({d.value})
          </div>
        ))}
      </div>
    </div>
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
    <div className="space-y-3">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <Icon icon={BarChart3} size="xs" />
        Valuation & Fundamentals
      </p>
      <ChartContainer config={barChartConfig} className="w-full h-[160px]">
        <BarChart
          accessibilityLayer
          data={data}
          layout="vertical"
          margin={{ left: 8, right: 32, top: 0, bottom: 0 }}
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
                  return (
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Valuation & Fundamentals
                      </span>
                      <span className="text-xs text-muted-foreground">{payload?.name || "Metric"}</span>
                      <span className="text-sm font-semibold">{Number(value).toLocaleString()}</span>
                    </div>
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
    </div>
  );
}

function PriceTargetsChart({ targets }: { targets: Record<string, number> }) {
  const data = Object.entries(targets)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .slice(0, 4)
    .map(([key, value]) => ({
      scenario: key.replace(/_/g, " ").replace(/\b\w/g, (letter: string) => letter.toUpperCase()),
      value: value as number,
    }));

  if (data.length < 2) return null;

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <Icon icon={TrendingUp} size="xs" />
        Price Scenarios
      </p>
      <ChartContainer config={barChartConfig} className="w-full h-[190px]">
        <BarChart accessibilityLayer data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" strokeOpacity={0.55} />
          <XAxis
            dataKey="scenario"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            tickMargin={8}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
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
                  return (
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Price Scenarios
                      </span>
                      <span className="text-xs text-muted-foreground">{payload?.scenario || "Scenario"}</span>
                      <span className="text-sm font-semibold">${Number(value).toFixed(2)}</span>
                    </div>
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
              fill="hsl(var(--foreground))"
              formatter={(value: number) => `$${value.toFixed(2)}`}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
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
  const sources = useMemo(() => {
    const sourceList: string[] = [];
    for (const source of rawCard?.all_sources || []) {
      if (typeof source === "string" && source.trim()) {
        sourceList.push(source.trim());
      }
    }
    for (const highlight of rawCard?.debate_highlights || []) {
      if (typeof highlight?.source === "string" && highlight.source.trim()) {
        sourceList.push(highlight.source.trim());
      }
    }
    const alphaAgentsPaper = rawCard?.alphaagents_trace?.paper;
    if (typeof alphaAgentsPaper === "string" && alphaAgentsPaper.trim()) {
      sourceList.push(`AlphaAgents Reference: ${alphaAgentsPaper.trim()}`);
    }

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const value of sourceList) {
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(value);
    }
    return deduped;
  }, [rawCard?.all_sources, rawCard?.alphaagents_trace?.paper, rawCard?.debate_highlights]);
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

        {/* DATA VISUALIZATION GRID */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
            <div className="p-4 bg-background/50 border border-primary/10 rounded-2xl backdrop-blur-sm">
                <div className="flex items-center gap-2 mb-2">
                <Icon icon={Shield} size="sm" className="text-primary" />
                <span className="text-xs font-bold text-primary uppercase tracking-wide">Risk Alignment</span>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{rawCard.risk_persona_alignment}</p>
            </div>
            )}

            {/* Key Takeaway - Highlight the most important insight */}
            {rawCard?.fundamental_insight?.summary && (
            <div className="p-5 bg-linear-to-br from-primary/10 via-primary/5 to-transparent border border-primary/20 rounded-2xl shadow-sm relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                    <Icon icon={Zap} size={96} className="rotate-12" />
                </div>
                <div className="relative z-10">
                    <div className="flex items-center gap-2 mb-2">
                    <Icon icon={Zap} size="sm" className="text-primary" />
                    <span className="text-xs font-black uppercase tracking-widest text-primary">Key Takeaway</span>
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
            <div className="p-4 bg-blue-500/5 border border-blue-500/10 rounded-2xl">
                <div className="flex items-center gap-2 mb-2">
                <Icon icon={Shield} size="xs" className="text-blue-500" />
                <span className="text-[10px] font-bold text-blue-500 uppercase tracking-widest">Moat</span>
                </div>
                <p className="text-xs text-muted-foreground">{rawCard.fundamental_insight.business_moat}</p>
            </div>
            )}
            
            {/* Sentiment Gauge Card */}
            {rawCard?.key_metrics?.sentiment?.sentiment_score !== undefined && (
            <div className="p-4 bg-card/40 border border-border/50 rounded-2xl flex flex-col justify-center">
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
                        <Icon icon={BarChart3} size="xs" style={{ color: RESULT_CHART_COLORS.accent }} />
                        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: RESULT_CHART_COLORS.accent }}>Sentiment</span>
                    </div>
                    <Badge variant="outline" className="text-[10px] font-mono bg-muted/30 border-border/40">
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
                <div className="p-4 bg-emerald-500/5 border border-emerald-500/10 rounded-2xl">
                <div className="flex items-center gap-2 mb-2">
                    <Icon icon={TrendingUp} size="xs" className="text-emerald-500" />
                    <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">Bull Case</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{rawCard.fundamental_insight.bull_case}</p>
                </div>
            )}
            {rawCard.fundamental_insight.bear_case && (
                <div className="p-4 bg-red-500/5 border border-red-500/10 rounded-2xl">
                <div className="flex items-center gap-2 mb-2">
                    <Icon icon={TrendingDown} size="xs" className="text-red-500" />
                    <span className="text-[10px] font-bold text-red-500 uppercase tracking-widest">Bear Case</span>
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
              <div className="p-3 bg-card/40 rounded-xl border border-border/40">
                <p className="text-[9px] text-muted-foreground uppercase tracking-widest mb-1 font-bold">Resilience</p>
                <p className="text-xs font-medium">{rawCard.fundamental_insight.financial_resilience}</p>
              </div>
            )}
            {rawCard.fundamental_insight.growth_efficiency && (
              <div className="p-3 bg-card/40 rounded-xl border border-border/40">
                <p className="text-[9px] text-muted-foreground uppercase tracking-widest mb-1 font-bold">Growth Eff.</p>
                <p className="text-xs font-medium">{rawCard.fundamental_insight.growth_efficiency}</p>
              </div>
            )}
          </div>
        )}

        {/* FINAL STATEMENT */}
        <div className="p-5 bg-card/60 rounded-2xl border border-border/60">
            <div className="flex items-center gap-2 mb-2 opacity-50">
                <Icon icon={FileText} size="xs" />
                <span className="text-[10px] font-bold uppercase tracking-widest">Verdict Rationale</span>
            </div>
            <p className="text-sm font-medium leading-relaxed">{rawCard?.debate_digest || result.final_statement}</p>
        </div>

        {/* LLM SYNTHESIS */}
        {(llmSynthesis?.thesis || llmSynthesis?.horizon_fit || llmSynthesis?.error) && (
          <div className="p-5 bg-primary/5 border border-primary/20 rounded-2xl space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-black uppercase tracking-widest text-primary flex items-center gap-1.5">
                <Icon icon={Target} size="xs" />
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
              <div className="p-3 rounded-xl border border-primary/20 bg-background/50">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">
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
              <div className="p-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/5">
                <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400 mb-2 flex items-center gap-1.5">
                  <Icon icon={TrendingUp} size="xs" />
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
              <div className="p-4 rounded-2xl border border-red-500/20 bg-red-500/5">
                <p className="text-[10px] font-bold uppercase tracking-widest text-red-600 dark:text-red-400 mb-2 flex items-center gap-1.5">
                  <Icon icon={Shield} size="xs" />
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
              <div className="p-4 rounded-2xl border border-blue-500/20 bg-blue-500/5">
                <p className="text-[10px] font-bold uppercase tracking-widest text-blue-600 dark:text-blue-400 mb-2 flex items-center gap-1.5">
                  <Icon icon={Target} size="xs" />
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
              <div className="p-4 rounded-2xl border border-amber-500/20 bg-amber-500/5">
                <p className="text-[10px] font-bold uppercase tracking-widest text-amber-600 dark:text-amber-400 mb-2 flex items-center gap-1.5">
                  <Icon icon={Zap} size="xs" />
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
          <div className="p-4 bg-card/40 rounded-2xl border border-border/40 space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
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
          <div className="p-4 bg-amber-500/5 border border-amber-500/20 rounded-2xl">
            <p className="text-xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-2 flex items-center gap-1.5">
              <Icon icon={Scale} size="xs" />
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
                  <SourceLink key={`${src}-${i}`} source={src} />
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

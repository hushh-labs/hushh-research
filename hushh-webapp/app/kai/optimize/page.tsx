"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/firebase/auth-context";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardHeader,
  SurfaceCardTitle,
  SurfaceStack,
} from "@/components/app-ui/surfaces";
import { useVault } from "@/lib/vault/vault-context";
import { ApiService } from "@/lib/services/api-service";
import { KaiProfileService, type KaiProfileV2 } from "@/lib/services/kai-profile-service";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { consumeCanonicalKaiStream } from "@/lib/streaming/kai-stream-client";
import type { KaiStreamEnvelope } from "@/lib/streaming/kai-stream-types";
import { ensureKaiVaultOwnerToken, isKaiAuthStatus } from "@/lib/services/kai-token-guard";
import { Button } from "@/lib/morphy-ux/button";
import { StreamingAccordion } from "@/lib/morphy-ux/streaming-accordion";
import { Progress } from "@/components/ui/progress";
import { Activity, Zap, ArrowRight, TrendingDown, TrendingUp, ShieldCheck, Target, Info, LayoutDashboard, ListChecks } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/morphy-ux/ui";
import { 
  Radar, RadarChart, PolarGrid, PolarAngleAxis, 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, 
  Legend
} from "recharts";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { toInvestorStreamText } from "@/lib/copy/investor-language";
import type { PortfolioSource } from "@/lib/kai/brokerage/portfolio-sources";

type LoserInput = {
  symbol: string;
  name?: string;
  gain_loss_pct?: number;
  gain_loss?: number;
  market_value?: number;
};

type OptimizePlanAction = {
  symbol?: string;
  name?: string;
  current_weight_pct?: number;
  target_weight_pct?: number;
  action?: string;
  rationale?: string;
  criteria_refs?: string[];
  renaissance_tier?: string;
  avoid_flag?: boolean;
};

type OptimizeSummary = {
  health_score?: number;
  health_reasons?: string[];
  portfolio_diagnostics?: {
    total_losers_value?: number;
    avoid_weight_estimate_pct?: number;
    investable_weight_estimate_pct?: number;
    concentration_notes?: string[];
  };
  projected_health_score?: number;
  plans?: {
    minimal?: { actions?: OptimizePlanAction[] };
    standard?: { actions?: OptimizePlanAction[] };
    maximal?: { actions?: OptimizePlanAction[] };
  };
  [key: string]: unknown;
};

type AnalysisResult = {
  criteria_context: string;
  summary: OptimizeSummary;
  losers: OptimizePlanAction[];
  portfolio_level_takeaways: string[];
  analytics?: {
    health_radar: {
      current: Record<string, number>;
      optimized: Record<string, number>;
    };
    sector_shift: { sector: string; before_pct: number; after_pct: number }[];
  };
};

const chartConfig = {
  current: {
    label: "Current",
    color: "var(--chart-5)",
  },
  optimized: {
    label: "Optimized",
    color: "var(--chart-3)",
  },
  score: {
    label: "Score",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

// Hook to force re-render on theme change
function useThemeAware() {
  const [theme, setTheme] = useState("dark");
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === "class") {
          setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
        }
      });
    });
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export default function PortfolioHealthPage() {
  const router = useRouter();
  const theme = useThemeAware();
  const { user, loading: authLoading } = useAuth();
  const { vaultOwnerToken, vaultKey, tokenExpiresAt, unlockVault, getVaultOwnerToken } = useVault();
  const setBusyOperation = useKaiSession((s) => s.setBusyOperation);

  useEffect(() => {
    setBusyOperation("portfolio_health_active", true);
    return () => {
      setBusyOperation("portfolio_health_active", false);
    };
  }, [setBusyOperation]);
  
  // Loading and result state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  
  // Streaming state
  const [isStreaming, setIsStreaming] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [currentStage, setCurrentStage] = useState<string>("analyzing");
  const [progressPct, setProgressPct] = useState<number>(5);
  const [statusMessage, setStatusMessage] = useState(
    "Optimizing suggestions using curated rulesets across your portfolio context."
  );
  const abortControllerRef = useRef<AbortController | null>(null);
  const [kaiProfile, setKaiProfile] = useState<KaiProfileV2 | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // New streaming states for granular control
  const [thoughts, setThoughts] = useState<string[]>([]);
  const [thoughtCount, setThoughtCount] = useState(0);
  const [isThinking, setIsThinking] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [streamedText, setStreamedText] = useState(""); // For the extraction phase

  const input = useKaiSession((s) => s.losersInput) as {
    userId: string;
    thresholdPct?: number;
    maxPositions?: number;
    losers: LoserInput[];
    hadBelowThreshold?: boolean;
    holdings?: Array<
      LoserInput & {
        weight_pct?: number;
        sector?: string;
        asset_type?: string;
      }
    >;
    forceOptimize?: boolean;
    portfolioSource?: PortfolioSource;
    portfolioContext?: Record<string, unknown> | null;
    sourceMetadata?: Record<string, unknown> | null;
  } | null;

  useEffect(() => {
    let cancelled = false;

    async function loadProfile() {
      if (!user?.uid || !vaultKey || !vaultOwnerToken) {
        setKaiProfile(null);
        return;
      }

      try {
        const profile = await KaiProfileService.getProfile({
          userId: user.uid,
          vaultKey,
          vaultOwnerToken,
        });
        if (!cancelled) {
          setKaiProfile(profile);
        }
      } catch {
        if (!cancelled) {
          setKaiProfile(null);
        }
      }
    }

    loadProfile();

    return () => {
      cancelled = true;
    };
  }, [user?.uid, vaultKey, vaultOwnerToken]);

  const thoughtsText = useMemo(() => {
    return thoughts.map((t, i) => `[${i + 1}] ${t.replace(/\*\*/g, "")}`).join("\n");
  }, [thoughts]);

  const contextStats = useMemo(() => {
    const holdings = input?.holdings ?? [];
    const totalValue = holdings.reduce(
      (sum, h) => sum + (typeof h.market_value === "number" ? h.market_value : 0),
      0
    );
    const sorted = [...holdings].sort(
      (a, b) => (b.market_value ?? 0) - (a.market_value ?? 0)
    );
    const top3WeightPct =
      totalValue > 0
        ? (sorted
            .slice(0, 3)
            .reduce((sum, h) => sum + (typeof h.market_value === "number" ? h.market_value : 0), 0) /
            totalValue) *
          100
        : 0;
    const sectorCount = new Set(
      holdings
        .map((h) => (typeof h.sector === "string" ? h.sector.trim() : ""))
        .filter((sector) => sector.length > 0)
    ).size;

    return {
      holdingsCount: holdings.length,
      losersCount: input?.losers?.length ?? 0,
      totalValue,
      top3WeightPct,
      sectorCount,
    };
  }, [input]);

  const sourceLabel = useMemo(() => {
    const raw = String(input?.portfolioSource || "").trim().toLowerCase();
    if (raw === "plaid") return "Plaid";
    return "Statement";
  }, [input?.portfolioSource]);
  
  const radarData = useMemo(() => {
    if (!result?.analytics?.health_radar) return [];
    const current = result.analytics.health_radar.current;
    const optimized = result.analytics.health_radar.optimized;
    return Object.keys(current).map(key => ({
      subject: key,
      A: current[key] || 0,
      B: optimized[key] || 0,
      fullMark: 100
    }));
  }, [result]);

  const sectorData = useMemo(() => {
    return result?.analytics?.sector_shift || [];
  }, [result]);

  // Run streaming analysis
  useEffect(() => {
    async function runStreamingAnalysis() {
      if (authLoading) return;
      
      if (!input) {
        setLoading(false);
        setError("No Optimize Portfolio context found. Please start from the Kai portfolio.");
        return;
      }

      if (!user) {
        setLoading(false);
        setError("Missing session context. Please return to Kai portfolio.");
        return;
      }

      try {
        setLoading(true);
        setError(null);
        setIsStreaming(true);
        setBusyOperation("portfolio_optimize_stream", true);
        setIsComplete(false);
        setThoughts([]); // Clear old thoughts
        setThoughtCount(0);
        setStreamedText(""); // Clear old streamed text
        setCurrentStage("analyzing");
        setProgressPct(8);
        setStatusMessage("Preparing portfolio context and optimization universe...");
        setErrorCode(null);
        setIsThinking(false);
        setIsExtracting(false);

        // Create abort controller for cleanup
        abortControllerRef.current = new AbortController();

        const resolveToken = async (forceRefresh = false): Promise<string> => {
          const token = await ensureKaiVaultOwnerToken({
            userId: user.uid,
            currentToken: getVaultOwnerToken() ?? vaultOwnerToken,
            currentExpiresAt: tokenExpiresAt,
            forceRefresh,
            onIssued: (issuedToken, expiresAt) => {
              if (vaultKey) {
                unlockVault(vaultKey, issuedToken, expiresAt);
              }
            },
          });
          return token;
        };

        const userPreferences = {
          risk_profile: kaiProfile?.preferences.risk_profile ?? null,
          risk_score: kaiProfile?.preferences.risk_score ?? null,
          investment_horizon: kaiProfile?.preferences.investment_horizon ?? null,
          investment_horizon_anchor_at:
            kaiProfile?.preferences.investment_horizon_anchor_at ?? null,
          drawdown_response: kaiProfile?.preferences.drawdown_response ?? null,
          volatility_preference:
            kaiProfile?.preferences.volatility_preference ?? null,
          holdings_count: contextStats.holdingsCount,
          losers_count: contextStats.losersCount,
          top3_concentration_pct: Number(contextStats.top3WeightPct.toFixed(2)),
          sector_count: contextStats.sectorCount,
          force_optimize: Boolean(input.forceOptimize),
          portfolio_source: input.portfolioSource ?? "statement",
        };

        let effectiveToken = await resolveToken(false);
        let response = await ApiService.analyzePortfolioLosersStream({
          userId: user.uid,
          losers: input.losers,
          thresholdPct: input.thresholdPct,
          maxPositions: input.maxPositions,
          vaultOwnerToken: effectiveToken,
          holdings: input.holdings,
          forceOptimize: input.forceOptimize,
          userPreferences,
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok && isKaiAuthStatus(response.status)) {
          effectiveToken = await resolveToken(true);
          response = await ApiService.analyzePortfolioLosersStream({
            userId: user.uid,
            losers: input.losers,
            thresholdPct: input.thresholdPct,
            maxPositions: input.maxPositions,
            vaultOwnerToken: effectiveToken,
            holdings: input.holdings,
            forceOptimize: input.forceOptimize,
            userPreferences,
            signal: abortControllerRef.current.signal,
          });
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorRecord =
            errorData && typeof errorData === "object" && !Array.isArray(errorData)
              ? (errorData as Record<string, unknown>)
              : {};
          const detailMessage =
            typeof errorRecord.detail === "string"
              ? errorRecord.detail
              : typeof errorRecord.error === "string"
                ? errorRecord.error
                : null;
          throw new Error(detailMessage || "Portfolio health analysis failed");
        }

        const readNumber = (value: unknown): number | undefined =>
          typeof value === "number" && Number.isFinite(value) ? value : undefined;
        const readString = (value: unknown): string | undefined =>
          typeof value === "string" && value.trim().length > 0 ? value : undefined;
        const sanitizeStream = (value: unknown, fallback: string): string => {
          const next = toInvestorStreamText(value);
          if (next) return next;
          return fallback;
        };
        const stageProgressFallback: Record<string, number> = {
          analyzing: 20,
          thinking: 45,
          extracting: 75,
          parsing: 90,
          complete: 100,
        };
        const resolveProgress = (stage: string, raw: unknown): number => {
          const fromPayload = readNumber(raw);
          if (typeof fromPayload === "number") {
            return fromPayload;
          }
          return stageProgressFallback[stage] ?? 20;
        };

        await consumeCanonicalKaiStream(
          response,
          (envelope: KaiStreamEnvelope) => {
            const payload = envelope.payload as Record<string, unknown>;

            switch (envelope.event) {
              case "stage": {
                const stage = typeof payload.stage === "string" ? payload.stage : "analyzing";
                setCurrentStage(stage);
                setIsThinking(stage === "thinking");
                setIsExtracting(stage === "extracting");
                setProgressPct(resolveProgress(stage, payload.progress_pct));
                setStatusMessage(
                  sanitizeStream(payload.message, "Analyzing portfolio positions...")
                );
                break;
              }
              case "thinking": {
                const thought = sanitizeStream(payload.thought, "");
                if (thought) {
                  setThoughts((prev) => [...prev, thought]);
                }
                setThoughtCount((prev) => readNumber(payload.count) ?? prev + (thought ? 1 : 0));
                setCurrentStage("thinking");
                setProgressPct(resolveProgress("thinking", payload.progress_pct));
                setStatusMessage(
                  sanitizeStream(
                    payload.message,
                    "AI is reasoning through concentration and replacement scenarios..."
                  )
                );
                break;
              }
              case "chunk": {
                const text = typeof payload.text === "string" ? payload.text : "";
                if (text) {
                  const investorText = toInvestorStreamText(text) || text;
                  setStreamedText((prev) => prev + investorText);
                }
                setCurrentStage("extracting");
                setIsExtracting(true);
                setProgressPct(resolveProgress("extracting", payload.progress_pct));
                setStatusMessage(
                  sanitizeStream(
                    payload.message,
                    "Streaming optimization output..."
                  )
                );
                break;
              }
              case "complete": {
                setResult(payload as unknown as AnalysisResult);
                setIsComplete(true);
                setIsStreaming(false);
                setIsThinking(false);
                setIsExtracting(false);
                setProgressPct(100);
                setStatusMessage("Optimization analysis complete.");
                break;
              }
              case "error": {
                const code = readString(payload.code);
                const message =
                  sanitizeStream(payload.message, "Portfolio health analysis failed");
                setErrorCode(code ?? null);
                const friendlyMessage =
                  code === "OPTIMIZE_PARSE_FAILED"
                    ? "We hit a formatting issue while composing optimization output. Please retry."
                    : message;
                setStatusMessage(friendlyMessage);
                throw new Error(friendlyMessage);
              }
              case "aborted": {
                const message =
                  sanitizeStream(payload.message, "Portfolio optimization stream was stopped");
                setStatusMessage(message);
                throw new Error(message);
              }
              default:
                break;
            }
          },
          {
            signal: abortControllerRef.current.signal,
            idleTimeoutMs: 180000,
            requireTerminal: true,
          }
        );

      } catch (e) {
        if ((e as Error).name === "AbortError") {
          console.log("[PortfolioHealth] Analysis aborted");
          setStatusMessage("Analysis stopped before completion.");
        } else {
          setError((e as Error).message);
          setStatusMessage(
            toInvestorStreamText((e as Error).message) || "Portfolio health analysis failed"
          );
          if ((e as Error).message.includes("formatting issue")) {
            setErrorCode("OPTIMIZE_PARSE_FAILED");
          }
        }
        setIsStreaming(false);
        setIsThinking(false);
        setIsExtracting(false);
      } finally {
        setLoading(false);
        setBusyOperation("portfolio_optimize_stream", false);
      }
    }

    runStreamingAnalysis();

    return () => {
      // Cleanup: abort any in-flight request
      abortControllerRef.current?.abort();
      setBusyOperation("portfolio_optimize_stream", false);
    };
  }, [
    authLoading,
    input,
    user,
    vaultOwnerToken,
    tokenExpiresAt,
    getVaultOwnerToken,
    unlockVault,
    vaultKey,
    setBusyOperation,
    kaiProfile,
    contextStats.holdingsCount,
    contextStats.losersCount,
    contextStats.top3WeightPct,
    contextStats.sectorCount,
  ]);

  useEffect(() => {
    const abortStream = () => abortControllerRef.current?.abort();
    window.addEventListener("beforeunload", abortStream);
    window.addEventListener("pagehide", abortStream);

    let visibilityTimeout: ReturnType<typeof setTimeout> | undefined;
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        visibilityTimeout = setTimeout(abortStream, 5000);
      } else if (visibilityTimeout) {
        clearTimeout(visibilityTimeout);
        visibilityTimeout = undefined;
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      abortStream();
      window.removeEventListener("beforeunload", abortStream);
      window.removeEventListener("pagehide", abortStream);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (visibilityTimeout) {
        clearTimeout(visibilityTimeout);
      }
    };
  }, []);

  const stageMessages: Record<string, string> = {
    analyzing: "Analyzing portfolio positions...",
    thinking: "AI reasoning about portfolio health...",
    extracting: "Extracting optimization recommendations...",
    parsing: "Validating structured optimization output...",
    complete: "Portfolio optimization complete.",
  };
  const resolvedStatus =
    statusMessage || stageMessages[currentStage] || "Running portfolio health analysis...";
  const resolvedProgress = Math.max(0, Math.min(100, progressPct));
  const showLivePanels =
    loading || isStreaming || thoughts.length > 0 || streamedText.length > 0;
  const reasoningPanelText =
    thoughtsText ||
    [
      "Booting Vertex stream...",
      "Loading holdings context and Renaissance screening tables...",
      "Reasoning thoughts will appear here as soon as the first stream chunk arrives.",
    ].join("\n");
  const extractionPanelText =
    streamedText ||
    [
      "Initializing extraction runtime...",
      "Streaming optimizer output will appear here in real time.",
    ].join("\n");

  return (
    <AppPageShell
      as="div"
      width="expanded"
      className="pb-6 sm:pb-8"
      nativeTest={{
        routeId: "/kai/optimize",
        marker: "native-route-kai-optimize",
        authState: user ? "authenticated" : "pending",
        dataState: loading
          ? "loading"
          : error
            ? "unavailable-valid"
            : result
              ? "loaded"
              : "empty-valid",
        errorCode: errorCode || null,
        errorMessage: error,
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Kai Optimize"
          title="Portfolio Optimization"
          description="Use the active portfolio context to review risks, proposed actions, and streamed optimizer output in one place."
          icon={Activity}
          accent="emerald"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack>

      <SurfaceCard>
        <SurfaceCardContent className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline">Source: {sourceLabel}</Badge>
            <Badge variant="secondary">{contextStats.holdingsCount} holdings</Badge>
            <Badge variant="secondary">{contextStats.losersCount} flagged losers</Badge>
            <Badge variant="secondary">Top 3 concentration {contextStats.top3WeightPct.toFixed(1)}%</Badge>
            <Badge variant="secondary">{contextStats.sectorCount || 0} sectors</Badge>
            {kaiProfile?.preferences.risk_profile && (
              <Badge variant="outline">Preference Risk: {kaiProfile.preferences.risk_profile}</Badge>
            )}
            {kaiProfile?.preferences.investment_horizon && (
              <Badge variant="outline">Horizon: {kaiProfile.preferences.investment_horizon}</Badge>
            )}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Optimize is using the active {sourceLabel.toLowerCase()} portfolio context selected from the Kai portfolio.
          </p>
        </SurfaceCardContent>
      </SurfaceCard>

      {showLivePanels && (
        <SurfaceCard accent="sky">
          <SurfaceCardContent className="space-y-3 p-4 sm:p-5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{resolvedStatus}</span>
              <span>{Math.round(resolvedProgress)}%</span>
            </div>
            <Progress
              value={resolvedProgress}
              className={cn(
                "h-2 [&_[data-slot=progress-indicator]]:transition-all [&_[data-slot=progress-indicator]]:duration-500",
                isStreaming && "[&_[data-slot=progress-indicator]]:animate-pulse"
              )}
            />
          </SurfaceCardContent>
        </SurfaceCard>
      )}

      {showLivePanels && (
        <StreamingAccordion
          id="ai-reasoning"
          title={`AI Reasoning${thoughtCount > 0 ? ` (${thoughtCount} thoughts)` : ""}`}
          text={reasoningPanelText}
          isStreaming={isStreaming || isThinking || isExtracting}
          isComplete={isComplete}
          icon={isComplete ? "brain" : "spinner"}
          iconClassName="w-6 h-6"
          maxHeight="260px"
          className="border-primary/10"
          autoCollapseOnComplete={false}
          emptyStreamingMessage="Initializing portfolio reasoning stream..."
        />
      )}

      {showLivePanels && (
        <StreamingAccordion
          id="optimizer-runtime"
          title="Live Optimizer Runtime"
          text={extractionPanelText}
          isStreaming={isStreaming}
          isComplete={isComplete}
          icon={isComplete ? "database" : "spinner"}
          iconClassName="w-6 h-6"
          maxHeight="260px"
          className="border-primary/10"
          autoCollapseOnComplete={false}
          emptyStreamingMessage="Waiting for first optimization chunks..."
          bodyClassName="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
        />
      )}

      {/* Neutral fallback card only when we have no result and no error */}
      {!loading && !error && !result && !isStreaming && (
        <SurfaceCard>
          <SurfaceCardHeader>
            <SurfaceCardTitle>Optimization Ready</SurfaceCardTitle>
          </SurfaceCardHeader>
          <SurfaceCardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Optimizing suggestions using curated rulesets across your portfolio context.
            </p>
          </SurfaceCardContent>
        </SurfaceCard>
      )}

      {!loading && error && (
        <SurfaceCard tone="warning">
          <SurfaceCardHeader>
            <SurfaceCardTitle>Optimization temporarily unavailable</SurfaceCardTitle>
          </SurfaceCardHeader>
          <SurfaceCardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{error}</p>
            {errorCode === "OPTIMIZE_PARSE_FAILED" && (
              <p className="text-xs text-muted-foreground">
                Kai will retry safely if you rerun optimization.
              </p>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button size="default" onClick={() => router.refresh()}>
                Retry optimization
              </Button>
              <Button
                size="default"
                variant="blue-gradient"
                effect="fade"
                onClick={() => router.push("/kai/portfolio")}
              >
                Back to portfolio
              </Button>
            </div>
          </SurfaceCardContent>
        </SurfaceCard>
      )}

      {/* Results - shown after streaming completes */}
      {isComplete && result && (
        <>
          {/* 1. High-Level Portfolio Health Summary - REBUILT LAYOUT */}
          <SurfaceCard accent="sky">
            <SurfaceCardHeader className="border-b border-border/5 bg-muted/5 px-6 py-4">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-primary/10">
                  <Icon icon={LayoutDashboard} size="sm" className="text-primary" />
                </div>
                <SurfaceCardTitle className="text-sm font-bold uppercase tracking-widest text-foreground">
                  Portfolio Intelligence & Health
                </SurfaceCardTitle>
              </div>
            </SurfaceCardHeader>
            
            <SurfaceCardContent className="p-0">
              <div className="flex flex-col md:grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border/10">
                
                {/* LEFT COLUMN: Visual Analytics (The Graph) */}
                <div className="relative p-6 md:p-8 bg-gradient-to-b from-muted/10 to-transparent">
                  <div className="absolute top-4 left-4 md:top-6 md:left-6 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
                    Health Radar
                  </div>
                  
                  {/* Chart Container - Fixed Height */}
                  <div className="h-[280px] w-full flex items-center justify-center -mt-2">
                    {radarData.length > 0 ? (
                      <ChartContainer config={chartConfig} className="h-full w-full max-w-[320px]" key={theme}>
                        <RadarChart cx="50%" cy="50%" outerRadius="75%" data={radarData}>
                          <PolarGrid stroke="var(--border)" strokeOpacity={0.2} />
                          <PolarAngleAxis 
                            dataKey="subject" 
                            tick={{ fill: "var(--muted-foreground)", fontSize: 10, fontWeight: 800, style: { textTransform: "uppercase" } }} 
                          />
                          <Radar
                            name="Current"
                            dataKey="A"
                            stroke="var(--color-current)"
                            fill="var(--color-current)"
                            fillOpacity={0.4}
                          />
                          <Radar
                            name="Optimized"
                            dataKey="B"
                            stroke="var(--color-optimized)"
                            fill="var(--color-optimized)"
                            fillOpacity={0.6}
                          />
                          <ChartTooltip
                            cursor={false}
                            content={
                              <ChartTooltipContent
                                formatter={(value, name) => (
                                  <div className="flex items-center justify-between gap-3 min-w-[120px]">
                                    <span className="text-muted-foreground">{String(name)}</span>
                                    <span className="font-semibold text-foreground">
                                      {Number(value).toFixed(1)}%
                                    </span>
                                  </div>
                                )}
                              />
                            }
                          />
                        </RadarChart>
                      </ChartContainer>
                    ) : (
                      <div className="flex items-center justify-center h-full text-xs text-muted-foreground italic">
                        Visualizing alpha metrics...
                      </div>
                    )}
                  </div>

                  {/* Chart Legend */}
                  <div className="flex justify-center gap-6 mt-[-10px]">
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-background/50 border border-border/5 backdrop-blur-sm">
                      <div className="w-2 h-2 rounded-full bg-[var(--color-current)]" />
                      <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Current</span>
                    </div>
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-background/50 border border-border/5 backdrop-blur-sm">
                      <div className="w-2 h-2 rounded-full bg-[var(--color-optimized)]" />
                      <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Optimized</span>
                    </div>
                  </div>
                </div>

                {/* RIGHT COLUMN: Scoring & Insights */}
                <div className="flex flex-col p-6 md:p-8 space-y-8">
                  
                  {/* Primary Score Module */}
                  {typeof result.summary.health_score === "number" && (
                    <div className="space-y-6">
                      <div className="space-y-4">
                         {/* Header Row */}
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <span className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em]">
                            Alpha Alignment
                          </span>
                          
                          {result.summary.projected_health_score && (
                            <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/20">
                               <span className="text-[9px] font-black uppercase tracking-wider text-emerald-500">Projected Goal</span>
                               <span className="text-xs font-black text-emerald-500">{result.summary.projected_health_score.toFixed(0)}%</span>
                            </div>
                          )}
                        </div>

                        {/* Big Score Row */}
                        <div className="flex items-baseline gap-1">
                          <span className="text-7xl font-black tracking-tighter text-foreground leading-none">
                            {result.summary.health_score.toFixed(0)}
                          </span>
                          <span className="text-2xl font-bold text-muted-foreground/40">%</span>
                        </div>
                      </div>

                      {/* Progress Bar & Scale */}
                      <div className="space-y-2">
                        <div className="h-3 w-full bg-muted/30 rounded-full overflow-hidden p-[2px]">
                          <div 
                             className={cn(
                               "h-full rounded-full transition-all duration-1000 ease-out shadow-lg",
                               result.summary.health_score < 40 ? "bg-gradient-to-r from-red-600 to-red-400" :
                               result.summary.health_score < 70 ? "bg-gradient-to-r from-amber-500 to-amber-300" :
                               "bg-gradient-to-r from-emerald-600 to-emerald-400"
                             )}
                             style={{ width: `${result.summary.health_score}%` }}
                          />
                        </div>
                        <div className="flex justify-between px-1">
                           <span className="text-[9px] uppercase font-bold text-red-500/70">Critical</span>
                           <span className="text-[9px] uppercase font-bold text-amber-500/70">Stable</span>
                           <span className="text-[9px] uppercase font-bold text-emerald-500/70">Optimal</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Strategic Insights Module */}
                  <div className="flex-1 flex flex-col justify-end pt-6 border-t border-border/10">
                    <h4 className="flex items-center gap-2 text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em] mb-4">
                      <Icon icon={ListChecks} size="sm" className="text-primary" />
                      Key Insights
                    </h4>
                    
                    {Array.isArray(result.summary.health_reasons) && result.summary.health_reasons.length > 0 ? (
                      <div className="space-y-3">
                        {result.summary.health_reasons.slice(0, 3).map((r, idx) => (
                          <div key={idx} className="flex gap-3 group">
                            <div className="w-1 h-1 rounded-full bg-primary mt-2 shrink-0 group-hover:scale-125 transition-transform" />
                            <p className="text-sm font-medium text-foreground/80 leading-relaxed group-hover:text-foreground transition-colors">
                              {r}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground italic pl-2">No specific observations noted.</p>
                    )}
                  </div>

                </div>
              </div>
            </SurfaceCardContent>
          </SurfaceCard>
          {result.summary.portfolio_diagnostics && (
            <div className="p-4 md:p-6 grid gap-3 md:gap-4 grid-cols-1 sm:grid-cols-3">
                  {[
                    { label: "Exposure Value", value: result.summary.portfolio_diagnostics.total_losers_value ? `$${result.summary.portfolio_diagnostics.total_losers_value.toLocaleString()}` : "N/A", icon: Target },
                    { label: "Avoid Risk", value: result.summary.portfolio_diagnostics.avoid_weight_estimate_pct ? `${result.summary.portfolio_diagnostics.avoid_weight_estimate_pct}%` : "0%", icon: ShieldCheck },
                    { label: "Alpha Conviction", value: result.summary.portfolio_diagnostics.investable_weight_estimate_pct ? `${result.summary.portfolio_diagnostics.investable_weight_estimate_pct}%` : "0%", icon: Zap }
                  ].map((stat, i) => (
                    <div key={i} className="flex items-center gap-3 md:gap-4 px-4 py-4 md:px-6 md:py-5 rounded-3xl bg-muted/30 border border-border/40 shadow-sm">
                      <div className="p-3 rounded-2xl bg-primary/10">
                        <Icon icon={stat.icon} size="md" className="text-primary" />
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-[10px] text-muted-foreground font-black uppercase tracking-widest">{stat.label}</span>
                        <span className="text-sm font-black text-foreground">{stat.value}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}


          {/* 1.5. Sector Transformation Analytics */}
          {sectorData.length > 0 && (
            <SurfaceCard>
              <SurfaceCardHeader className="pb-0">
                <SurfaceCardTitle className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  <Icon icon={TrendingUp} size={12} className="text-primary" />
                  Sector Concentration Shift
                </SurfaceCardTitle>
              </SurfaceCardHeader>
              <SurfaceCardContent className="pt-6">
                <div className="h-64 w-full">
                  <ChartContainer config={chartConfig} className="h-full w-full">
                    <BarChart data={sectorData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.4} />
                      <XAxis 
                        dataKey="sector" 
                        axisLine={false} 
                        tickLine={false} 
                        tick={{ fill: "currentColor", opacity: 0.5, fontSize: 10, fontWeight: "bold" }}
                      />
                      <YAxis 
                        axisLine={false} 
                        tickLine={false} 
                        tick={{ fill: "currentColor", opacity: 0.5, fontSize: 10 }}
                        unit="%"
                      />
                      <ChartTooltip
                        cursor={false}
                        content={
                          <ChartTooltipContent
                            formatter={(value, name, _item, _index, payload) => {
                              const row = payload as { before_pct?: number; after_pct?: number };
                              return (
                                <div className="space-y-1">
                                  <p className="font-semibold text-foreground">
                                    {String(name)}: {Number(value).toFixed(1)}%
                                  </p>
                                  {typeof row.before_pct === "number" &&
                                    typeof row.after_pct === "number" && (
                                      <p className="text-xs text-muted-foreground">
                                        Delta {(row.after_pct - row.before_pct).toFixed(1)}%
                                      </p>
                                    )}
                                </div>
                              );
                            }}
                          />
                        }
                      />
                      <Legend 
                        verticalAlign="top" 
                        align="right" 
                        wrapperStyle={{
                          fontSize: "10px",
                          fontWeight: "bold",
                          textTransform: "uppercase",
                          letterSpacing: "0.1em",
                          paddingBottom: "20px",
                          color: "var(--muted-foreground)",
                        }} 
                      />
                      <Bar name="Current" dataKey="before_pct" fill="var(--color-current)" opacity={0.3} radius={[4, 4, 0, 0]} />
                      <Bar name="Optimized" dataKey="after_pct" fill="var(--color-optimized)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
                </div>
              </SurfaceCardContent>
            </SurfaceCard>
          )}

          {/* 2. Executive Rationale & Takeaways (Highest Prominence for Investors) */}
          {(result.portfolio_level_takeaways?.length || 0) > 0 && (
            <SurfaceCard accent="sky" className="relative">
              <SurfaceCardContent className="relative p-8">
               <div className="absolute top-0 right-0 p-4 opacity-5">
                 <Icon icon={ShieldCheck} size={128} className="text-foreground" />
               </div>
               <div className="relative z-10">
                <h3 className="text-xs font-black uppercase tracking-[0.2em] text-primary mb-6 flex items-center gap-2">
                  <Icon icon={Zap} size="sm" />
                  Executive Strategic Summary
                </h3>
                <ul className="grid gap-4 md:grid-cols-2">
                  {result.portfolio_level_takeaways.map((t, idx) => (
                    <li key={idx} className="flex gap-4 text-sm text-foreground/90 leading-relaxed font-semibold">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0" />
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
              </SurfaceCardContent>
            </SurfaceCard>
          )}

          {/* 3. Simulated Outcome (Projected Improvement) */}
          <SurfaceCard accent="emerald">
            <SurfaceCardHeader>
              <div className="flex items-center gap-2">
                <Icon icon={Zap} size="md" className="text-primary animate-pulse" />
                <SurfaceCardTitle className="text-sm font-black uppercase tracking-widest">Simulated Alignment Outcome</SurfaceCardTitle>
              </div>
            </SurfaceCardHeader>
            <SurfaceCardContent className="space-y-4">
              <p className="text-sm text-foreground/80 font-medium">
                By executing these {result.losers.length} adjustments, your portfolio's alpha alignment score is projected to move from <span className="text-red-400 font-black">{typeof result.summary.health_score === 'number' ? result.summary.health_score.toFixed(0) : "0"}</span> to <span className="text-emerald-400 font-black text-lg">{typeof result.summary.projected_health_score === 'number' ? `${result.summary.projected_health_score.toFixed(0)}+` : "92+"}</span>.
              </p>
              <div className="p-5 rounded-3xl bg-background/80 border border-border/10 space-y-4">
                <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  <span>Current Fragility</span>
                  <Icon icon={ArrowRight} size={12} />
                  <span>Optimized Resilience</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 md:gap-4">
                   <div className="h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-[10px] font-black text-red-500">
                     HIGH SPECULATIVE RISK
                   </div>
                   <div className="h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-[10px] font-black text-emerald-500">
                     CONVICTION ALPHA DIVERSITY
                   </div>
                </div>
              </div>
            </SurfaceCardContent>
          </SurfaceCard>

          {/* 4. Optimization Strategy (The "How") */}
          {result.losers.some(l => l.action && l.action.toLowerCase() !== 'hold') && (
            <SurfaceCard accent="amber">
              <SurfaceCardHeader className="pb-0">
                <div className="flex items-center gap-2">
                  <Icon icon={Target} size="md" className="text-primary" />
                  <SurfaceCardTitle>Optimization Trade Strategy</SurfaceCardTitle>
                </div>
              </SurfaceCardHeader>
              <SurfaceCardContent className="space-y-8 pt-6">
                {[
                  {
                    title: "Capital Harvest (Reduce/Exit)",
                    icon: TrendingDown,
                    iconColor: "text-red-400",
                    items: result.losers.filter(l => ["exit", "trim", "rotate"].includes(l.action?.toLowerCase() || "") || (l.current_weight_pct || 0) > (l.target_weight_pct || 0)),
                    banner: "bg-red-500/5 border-red-500/10 text-red-500",
                    actionType: "REDUCE"
                  },
                  {
                    title: "Conviction Reinvestment (Add/Entry)",
                    icon: TrendingUp,
                    iconColor: "text-emerald-400",
                    items: result.losers.filter(l => ["add", "rotate"].includes(l.action?.toLowerCase() || "") || (l.target_weight_pct || 0) > (l.current_weight_pct || 0)),
                    banner: "bg-emerald-500/5 border-emerald-500/10 text-emerald-500",
                    actionType: "ADD"
                  }
                ].map((group, groupIdx) => {
                  if (group.items.length === 0) return null;
                  
                  return (
                    <div key={groupIdx} className="space-y-4">
                      <div className={cn("flex items-center gap-2 px-3 py-2 rounded-xl border font-black text-[10px] uppercase tracking-widest", group.banner)}>
                        <group.icon className={cn("w-3.5 h-3.5", group.iconColor)} />
                        {group.title}
                      </div>

                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent border-white/5">
                            <TableHead className="w-[100px] text-[10px] uppercase font-black text-muted-foreground">Asset</TableHead>
                            <TableHead className="text-[10px] uppercase font-black text-muted-foreground">Tier</TableHead>
                            <TableHead className="text-[10px] uppercase font-black text-muted-foreground text-right">Target Δ</TableHead>
                            <TableHead className="text-[10px] uppercase font-black text-muted-foreground text-right">Rationale</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {group.items.map((l, lIdx) => {
                            const delta = Math.abs((l.current_weight_pct || 0) - (l.target_weight_pct || 0));
                            
                            return (
                              <TableRow key={lIdx} className="group border-white/5 hover:bg-white/5 transition-colors">
                                <TableCell className="py-4">
                                  <div className="flex flex-col">
                                    <span className="font-black text-xs text-foreground uppercase">{l.symbol}</span>
                                    <span className="text-[9px] text-muted-foreground truncate max-w-[100px] font-medium">{l.name}</span>
                                  </div>
                                </TableCell>
                                <TableCell>
                                  {l.renaissance_tier && (
                                    <Badge 
                                      variant="outline" 
                                      className={cn(
                                        "text-[9px] font-black tracking-widest px-1.5 py-0 rounded",
                                        l.renaissance_tier === "ACE" ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" :
                                        l.renaissance_tier === "KING" ? "bg-blue-500/10 text-blue-500 border-blue-500/20" :
                                        "bg-amber-500/10 text-amber-500 border-amber-500/20"
                                      )}
                                    >
                                      {l.renaissance_tier}
                                    </Badge>
                                  )}
                                </TableCell>
                                <TableCell className="text-right">
                                  <span className={cn(
                                    "text-xs font-black",
                                    group.actionType === "REDUCE" ? "text-red-500" : "text-emerald-500"
                                  )}>
                                    {group.actionType === "REDUCE" ? "–" : "+"}{delta > 0 ? `${delta.toFixed(1)}%` : "N/A"}
                                  </span>
                                </TableCell>
                                <TableCell className="text-right max-w-[120px]">
                                  <p className="text-[10px] text-muted-foreground leading-tight line-clamp-2">
                                    {l.rationale || "Rebalancing for alpha alignment."}
                                  </p>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  );
                })}
              </SurfaceCardContent>
            </SurfaceCard>
          )}

          {/* 5. Detailed Rebalance Plans (Scenario Logic) */}
          {result.summary.plans && (
            <SurfaceCard>
              <SurfaceCardHeader className="pb-4">
                <SurfaceCardTitle className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-muted-foreground">
                  <Icon icon={LayoutDashboard} size="sm" className="text-primary" />
                  Proposed Rebalance Path Scenarios
                </SurfaceCardTitle>
              </SurfaceCardHeader>
              <SurfaceCardContent>
                <Tabs defaultValue="standard" className="w-full">
                  <TabsList className="bg-muted p-1 rounded-2xl h-12 w-full grid grid-cols-3">
                    {(["minimal", "standard", "maximal"] as const).map((key) => (
                      <TabsTrigger 
                        key={key}
                        value={key} 
                        className="rounded-xl text-[10px] font-black uppercase tracking-widest data-[state=active]:bg-background data-[state=active]:text-primary transition-all"
                      >
                        {key}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  
                  {(["minimal", "standard", "maximal"] as const).map((key) => {
                    const plan = result.summary.plans?.[key];
                    if (!plan?.actions || plan.actions.length === 0) return null;
                    
                    return (
                      <TabsContent key={key} value={key} className="mt-6 space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-500">
                        <div className="grid gap-3">
                          {plan.actions.map((a, idx) => (
                            <div key={idx} className="flex flex-col md:flex-row md:items-center justify-between p-5 rounded-3xl bg-muted/20 border border-border/20 hover:border-primary/40 transition-all group gap-4 ring-1 ring-transparent hover:ring-primary/10">
                              <div className="flex items-center gap-4">
                                <div className={cn(
                                  "w-10 h-10 rounded-2xl flex items-center justify-center font-black text-xs",
                                  a.action?.toLowerCase() === "exit" ? "bg-red-500/20 text-red-500" :
                                  a.action?.toLowerCase() === "trim" ? "bg-amber-500/20 text-amber-500" :
                                  "bg-emerald-500/20 text-emerald-500"
                                )}>
                                  {a.symbol?.slice(0, 2).toUpperCase()}
                                </div>
                                <div className="flex flex-col">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-black text-foreground uppercase tracking-tight">{a.symbol}</span>
                                    <Badge variant="outline" className="text-[8px] h-4 font-black px-1.5 opacity-60">{a.action}</Badge>
                                  </div>
                                  <span className="text-[10px] font-medium text-muted-foreground line-clamp-1">{a.name || "Portfolio Holding"}</span>
                                </div>
                              </div>

                              <div className="flex flex-1 md:px-8">
                                <p className="text-[10px] text-muted-foreground leading-snug italic line-clamp-2 md:line-clamp-1">
                                  {a.rationale || "Strategic rebalancing for optimized alpha alignment."}
                                </p>
                              </div>

                              <div className="flex items-center justify-between md:justify-end gap-6 bg-white/5 md:bg-transparent p-3 md:p-0 rounded-2xl">
                                {typeof a.current_weight_pct === "number" && (
                                  <div className="flex flex-col items-end">
                                    <span className="text-[8px] font-black text-muted-foreground uppercase tracking-widest mb-0.5">Transition</span>
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-bold text-muted-foreground/60">{a.current_weight_pct.toFixed(1)}%</span>
                                      <Icon
                                        icon={ArrowRight}
                                        size={12}
                                        className="text-primary group-hover:translate-x-1 transition-transform"
                                      />
                                      <span className="text-sm font-black text-foreground">{(a.target_weight_pct ?? a.current_weight_pct).toFixed(1)}%</span>
                                    </div>
                                  </div>
                                )}
                                <Button size="sm" variant="muted" className="h-8 w-8 p-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity">
                                  <Icon icon={Info} size="xs" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </TabsContent>
                    );
                  })}
                </Tabs>
              </SurfaceCardContent>
            </SurfaceCard>
          )}

          {/* 6. Contextual Rubric & Extraction Status (Lower Prominence) */}
          <div className="grid gap-6 md:grid-cols-2">
            <SurfaceCard className="opacity-80 transition-opacity hover:opacity-100">
              <SurfaceCardHeader className="py-4">
                <SurfaceCardTitle className="text-[10px] font-black uppercase tracking-widest">Renaissance Alignment Context</SurfaceCardTitle>
              </SurfaceCardHeader>
              <SurfaceCardContent className="pb-4">
                <pre className="whitespace-pre-wrap text-[11px] text-muted-foreground/80 leading-relaxed font-medium">
                  {result.criteria_context}
                </pre>
              </SurfaceCardContent>
            </SurfaceCard>

            {streamedText && (
              <SurfaceCard accent="sky">
                <SurfaceCardHeader className="py-4">
                  <SurfaceCardTitle className="text-[10px] font-black uppercase tracking-widest">
                    Alpha Analysis Runtime Transcript
                  </SurfaceCardTitle>
                </SurfaceCardHeader>
                <SurfaceCardContent className="pt-0 pb-4">
                  <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-border/40 bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
                    {streamedText}
                  </pre>
                </SurfaceCardContent>
              </SurfaceCard>
            )}
          </div>
        </>
      )}
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

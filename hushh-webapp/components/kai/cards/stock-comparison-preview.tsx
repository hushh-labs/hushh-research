"use client";

import { BarChart3, GitCompareArrows, Loader2, SearchCheck } from "lucide-react";

import { SectionHeader } from "@/components/app-ui/page-sections";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceInset,
} from "@/components/app-ui/surfaces";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/lib/morphy-ux/button";
import {
  type KaiHomePickSource,
  type KaiStockPreviewResponse,
} from "@/lib/services/api-service";
import { cn } from "@/lib/utils";

function formatCurrency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Price unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Change unavailable";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatFcf(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `$${value.toFixed(value >= 10 ? 0 : 1)}B FCF`;
}

function describeAdvisorState(
  state: "ready" | "pending" | "unavailable",
  tickerStatus: "included" | "excluded" | "screened" | "not_listed" | "pending" | "unavailable"
): string {
  if (state === "pending") {
    return "Your advisor connection is active, but the shared package is not published yet.";
  }
  if (state === "unavailable") {
    return "Kai is falling back to the default list because the advisor package is unavailable right now.";
  }
  if (tickerStatus === "included") {
    return "This stock is included in the advisor package and will shape the debate context directly.";
  }
  if (tickerStatus === "excluded") {
    return "This stock is on the advisor avoid list and will enter the debate with that caution attached.";
  }
  if (tickerStatus === "screened") {
    return "This stock is not explicitly listed, but the advisor screening rubric will still shape the debate.";
  }
  return "This stock is not explicitly listed in the advisor package.";
}

export function StockComparisonPreview({
  preview,
  loading = false,
  error,
  onStartDebate,
  activePickSource,
  onPickSourceChange,
  compact = false,
  starting = false,
}: {
  preview: KaiStockPreviewResponse | null;
  loading?: boolean;
  error?: string | null;
  onStartDebate: () => void;
  activePickSource?: string;
  onPickSourceChange?: (sourceId: string) => void;
  compact?: boolean;
  starting?: boolean;
}) {
  const displaySources = preview?.pick_sources || [];
  const selectedSource =
    displaySources.find((source) => source.id === (activePickSource || preview?.active_pick_source)) ||
    displaySources[0] ||
    null;
  const advisorSummary = preview?.advisor_summary ?? null;

  return (
    <section>
      <SurfaceCard tone="feature">
        <SurfaceCardContent className={cn("space-y-6", compact ? "p-4 sm:p-5" : "p-5 sm:p-6")}>
          <SectionHeader
            eyebrow="Stock preview"
            title={preview ? `${preview.symbol} vs the active picks list` : "Compare before debate"}
            description={
              preview
                ? "Confirm the live quote against the current Kai list source before you launch the debate."
                : "Kai is preparing a live quote and list comparison."
            }
            icon={GitCompareArrows}
            accent="sky"
          />

          {loading ? (
            <div className="flex items-center gap-2 px-1 py-1 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading stock preview...
            </div>
          ) : null}

          {error ? <p className="px-1 py-1 text-sm text-red-500">{error}</p> : null}

          {preview ? (
            <SurfaceInset className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    Debate source
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Kai will use this active list context when the debate starts and when the result is saved.
                  </p>
                </div>
                <div className="w-full sm:w-auto sm:min-w-[220px]">
                  <Select
                    value={selectedSource?.id || preview.active_pick_source || "default"}
                    onValueChange={(nextValue) => {
                      if (!onPickSourceChange || nextValue === selectedSource?.id) return;
                      onPickSourceChange(nextValue);
                    }}
                  >
                    <SelectTrigger className="h-10 w-full rounded-full border-border/80 bg-background/80 text-left shadow-sm">
                      <SelectValue placeholder="Default list" />
                    </SelectTrigger>
                    <SelectContent
                      align="end"
                      position="popper"
                      className="w-[var(--radix-select-trigger-width)] min-w-[220px]"
                    >
                      {displaySources.map((source: KaiHomePickSource) => (
                        <SelectItem key={source.id} value={source.id}>
                          {source.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </SurfaceInset>
          ) : null}

          {!loading && !error && preview ? (
            <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1.15fr_1fr]">
            <SurfaceInset className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    Live market
                  </p>
                  <h3 className="text-lg font-semibold text-foreground">
                    {preview.quote.company_name}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {preview.quote.sector || "Sector unavailable"}
                  </p>
                </div>
                <Badge variant="secondary">{preview.symbol}</Badge>
              </div>
              <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-2">
                <p className="text-3xl font-semibold tracking-tight text-foreground">
                  {formatCurrency(preview.quote.price)}
                </p>
                <p
                  className={cn(
                    "text-sm font-medium",
                    (preview.quote.change_pct ?? 0) >= 0 ? "text-emerald-600" : "text-rose-600"
                  )}
                >
                  {formatPercent(preview.quote.change_pct)}
                </p>
              </div>
            </SurfaceInset>

            <SurfaceInset className="p-4">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  List comparison
                </p>
                <h3 className="text-lg font-semibold text-foreground">
                  {preview.list_match.in_list ? "Included on the active list" : "Not on the active list"}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {preview.list_match.in_list
                    ? preview.list_match.company_name || preview.quote.company_name
                    : "Kai does not currently match this stock to the selected picks list."}
                </p>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {preview.list_match.tier ? (
                  <Badge className="bg-sky-500/10 text-sky-700 dark:text-sky-300">
                    Tier {preview.list_match.tier}
                  </Badge>
                ) : null}
                {preview.list_match.recommendation_bias ? (
                  <Badge variant="secondary">{preview.list_match.recommendation_bias}</Badge>
                ) : null}
                {preview.list_match.sector ? <Badge variant="outline">{preview.list_match.sector}</Badge> : null}
                {formatFcf(preview.list_match.fcf_billions) ? (
                  <Badge variant="outline">{formatFcf(preview.list_match.fcf_billions)}</Badge>
                ) : null}
              </div>
            </SurfaceInset>
          </div>

          {advisorSummary ? (
            <SurfaceInset className="p-4">
              <div className="space-y-3">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    Your advisor shared
                  </p>
                  <h3 className="text-base font-semibold text-foreground">{advisorSummary.source_label}</h3>
                  <p className="text-sm text-muted-foreground">
                    {describeAdvisorState(advisorSummary.state, advisorSummary.ticker_status)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={advisorSummary.state === "ready" ? "secondary" : "outline"}>
                    {advisorSummary.state}
                  </Badge>
                  <Badge variant="outline">{advisorSummary.top_pick_count} top picks</Badge>
                  <Badge variant="outline">{advisorSummary.avoid_count} avoid</Badge>
                  <Badge variant="outline">{advisorSummary.screening_section_count} screening sections</Badge>
                </div>
                {advisorSummary.package_note ? (
                  <p className="text-sm text-foreground">{advisorSummary.package_note}</p>
                ) : null}
                {advisorSummary.avoid_reason ? (
                  <p className="text-xs text-muted-foreground">Avoid reason: {advisorSummary.avoid_reason}</p>
                ) : null}
              </div>
            </SurfaceInset>
          ) : null}

          <SurfaceInset className="p-4">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-sky-500/15 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                {preview.list_match.in_list ? <SearchCheck className="h-4 w-4" /> : <BarChart3 className="h-4 w-4" />}
              </span>
              <div className="min-w-0 space-y-2">
                <p className="text-sm font-medium text-foreground">
                  {preview.list_match.investment_thesis || "Kai can launch the full debate to generate the deeper thesis and recommendation context."}
                </p>
                <p className="text-xs text-muted-foreground">
                  Source: {selectedSource?.label || preview.list_match.label || preview.list_match.source_id} · Quote as of{" "}
                  {new Date(preview.quote.as_of || Date.now()).toLocaleString()}
                </p>
              </div>
            </div>
          </SurfaceInset>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="blue-gradient"
              effect="fill"
              onClick={onStartDebate}
              disabled={loading || starting}
            >
              {starting ? "Preparing debate..." : "Start debate"}
            </Button>
          </div>
        </div>
          ) : null}
        </SurfaceCardContent>
      </SurfaceCard>
    </section>
  );
}

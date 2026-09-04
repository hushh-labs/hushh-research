"use client";

import { BarChart3, GitCompareArrows, Loader2, Search, SearchCheck } from "lucide-react";

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
    return "One is falling back to the default list because the advisor package is unavailable right now.";
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
  onBrowseRecommendations,
  onChangeStock,
  activePickSource,
  onPickSourceChange,
  compact = false,
  starting = false,
  embeddedInDetailSurface = false,
  showStartAction = true,
}: {
  preview: KaiStockPreviewResponse | null;
  loading?: boolean;
  error?: string | null;
  onStartDebate: () => void;
  onBrowseRecommendations?: () => void;
  onChangeStock?: () => void;
  activePickSource?: string;
  onPickSourceChange?: (sourceId: string) => void;
  compact?: boolean;
  starting?: boolean;
  embeddedInDetailSurface?: boolean;
  showStartAction?: boolean;
}) {
  const displaySources = preview?.pick_sources || [];
  const selectedSource =
    displaySources.find((source) => source.id === (activePickSource || preview?.active_pick_source)) ||
    displaySources[0] ||
    null;
  const advisorSummary = preview?.advisor_summary ?? null;

  return (
    <section>
      <SurfaceCard
        tone="feature"
        className={cn(
          embeddedInDetailSurface &&
            "border-0 !bg-transparent shadow-none",
        )}
      >
        <SurfaceCardContent
          className={cn(
            embeddedInDetailSurface ? "space-y-2" : "space-y-6",
            embeddedInDetailSurface
              ? "px-4 pb-2 pt-1 sm:px-5 sm:pb-4 sm:pt-2"
              : compact
                ? "p-4 sm:p-5"
                : "p-5 sm:p-6",
          )}
        >
          {!embeddedInDetailSurface ? (
            <SectionHeader
            eyebrow="Stock preview"
            title={preview ? `${preview.symbol} vs the active picks list` : "Compare before debate"}
            description={
              preview
                ? "Confirm the live quote against the current Finance list source before you launch the debate."
                : "One is preparing a live quote and list comparison."
            }
            icon={GitCompareArrows}
            accent="default"
            actions={
              onBrowseRecommendations || onChangeStock ? (
                // Both action pills must stay fully visible on narrow iOS
                // widths. `flex-nowrap` previously let "Change stock" overflow
                // and clip off the card's right edge (see bug report). Allow the
                // row to WRAP the second pill onto a new line instead of
                // clipping it, and give the group full width so it aligns left
                // under the title on phones and right on wider screens.
                <div className="flex w-full flex-wrap items-center justify-start gap-1.5 sm:w-auto sm:justify-end">
                  {onBrowseRecommendations ? (
                    <Button
                      type="button"
                      variant="none"
                      effect="fade"
                      size="sm"
                      className="min-w-0 whitespace-nowrap px-2.5 text-xs sm:text-sm"
                      onClick={onBrowseRecommendations}
                    >
                      Recommendations
                    </Button>
                  ) : null}
                  {onChangeStock ? (
                    <Button
                      type="button"
                      variant="none"
                      effect="fade"
                      size="sm"
                      className="min-w-0 whitespace-nowrap px-2.5 text-xs sm:text-sm"
                      onClick={onChangeStock}
                    >
                      <Search className="mr-1 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      Change stock
                    </Button>
                  ) : null}
                </div>
              ) : null
            }
            />
          ) : null}

          {loading ? (
            <div className="flex items-center gap-2 px-1 py-1 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading stock preview...
            </div>
          ) : null}

          {error ? <p className="px-1 py-1 text-sm text-red-500">{error}</p> : null}

          {preview ? (
            <SurfaceInset
              className={cn(
                embeddedInDetailSurface
                  ? "rounded-none border-0 !bg-transparent p-0 shadow-none"
                  : "p-4",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                    Debate source
                  </p>
                  <p className={cn("text-sm text-muted-foreground", embeddedInDetailSurface && "hidden sm:block")}>
                    One will use this active list context when the debate starts and when the result is saved.
                  </p>
                </div>
                <div className="w-[min(11rem,58%)] shrink-0 sm:w-auto sm:min-w-[220px]">
                  <Select
                    value={selectedSource?.id || preview.active_pick_source || "default"}
                    onValueChange={(nextValue) => {
                      if (!onPickSourceChange || nextValue === selectedSource?.id) return;
                      onPickSourceChange(nextValue);
                    }}
                  >
                    <SelectTrigger className="h-10 w-full rounded-full border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] text-left shadow-[var(--shadow-xs)]">
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
            <div className={cn(embeddedInDetailSurface ? "space-y-2" : "space-y-4")}>
          <div
            className={cn(
              "grid gap-3 sm:grid-cols-[1.15fr_1fr]",
              embeddedInDetailSurface &&
                "grid-cols-2 gap-0 overflow-hidden rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-neutral-fill)]",
            )}
          >
            <SurfaceInset className={cn(embeddedInDetailSurface ? "rounded-none border-0 !bg-transparent p-3 shadow-none" : "p-4")}>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                    Live market
                  </p>
                  <h3 className={cn("font-semibold text-foreground", embeddedInDetailSurface ? "text-base" : "text-lg")}>
                    {preview.quote.company_name}
                  </h3>
                  <p className={cn("text-sm text-muted-foreground", embeddedInDetailSurface && "hidden sm:block")}>
                    {preview.quote.sector || "Sector unavailable"}
                  </p>
                </div>
                <Badge variant="secondary">{preview.symbol}</Badge>
              </div>
              <div className={cn("flex flex-wrap items-end gap-x-4 gap-y-2", embeddedInDetailSurface ? "mt-2" : "mt-4")}>
                <p className={cn("font-semibold tracking-tight text-foreground", embeddedInDetailSurface ? "text-xl sm:text-2xl" : "text-3xl")}>
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

            <SurfaceInset className={cn(embeddedInDetailSurface ? "rounded-none border-0 border-l border-[color:var(--app-card-border-standard)] !bg-transparent p-3 shadow-none" : "p-4")}>
              <div className="space-y-1">
                <p className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                  List comparison
                </p>
                <h3 className={cn("font-semibold text-foreground", embeddedInDetailSurface ? "text-base" : "text-lg")}>
                  {preview.list_match.in_list ? "Included on the active list" : "Not on the active list"}
                </h3>
                <p className={cn("text-sm text-muted-foreground", embeddedInDetailSurface && "line-clamp-2 text-xs leading-4")}>
                  {preview.list_match.in_list
                    ? preview.list_match.company_name || preview.quote.company_name
                    : "One does not currently match this stock to the selected picks list."}
                </p>
              </div>
              <div className={cn("flex flex-wrap gap-2", embeddedInDetailSurface ? "mt-2 hidden sm:flex" : "mt-4")}>
                {preview.list_match.tier ? (
                  <Badge className="bg-[color:var(--app-card-surface-compact)] text-muted-foreground">
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
            <SurfaceInset className={cn(embeddedInDetailSurface ? "p-3" : "p-4")}>
              <div className="space-y-3">
                <div className="space-y-1">
                  <p className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
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

          <SurfaceInset className={cn(embeddedInDetailSurface ? "rounded-none border-0 !bg-transparent p-2 shadow-none" : "p-4")}>
            <div className="flex items-start gap-3">
              <span className={cn("inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] text-muted-foreground", embeddedInDetailSurface && "h-8 w-8 rounded-xl")}>
                {preview.list_match.in_list ? <SearchCheck className="h-4 w-4" /> : <BarChart3 className="h-4 w-4" />}
              </span>
              <div className="min-w-0 space-y-2">
                <p className={cn("text-sm font-medium text-foreground", embeddedInDetailSurface && "line-clamp-2 text-xs leading-4")}>
                  {preview.list_match.investment_thesis || "One can launch the full debate to generate the deeper thesis and recommendation context."}
                </p>
                <p className={cn("text-xs text-muted-foreground", embeddedInDetailSurface && "hidden sm:block")}>
                  Source: {selectedSource?.label || preview.list_match.label || preview.list_match.source_id} · Quote as of{" "}
                  {new Date(preview.quote.as_of || Date.now()).toLocaleString()}
                </p>
              </div>
            </div>
          </SurfaceInset>

          {showStartAction ? (
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
          ) : null}
        </div>
          ) : null}
        </SurfaceCardContent>
      </SurfaceCard>
    </section>
  );
}

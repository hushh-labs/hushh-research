"use client";

import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Activity,
  Compass,
  History,
  Search,
  ShieldCheck,
  TrendingUp,
  UserRound,
  X,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  getTickerUniverseSnapshot,
  preloadTickerUniverse,
  searchTickerUniverseRemote,
  searchTickerUniverse,
  type TickerUniverseRow,
} from "@/lib/kai/ticker-universe-cache";
import {
  evaluateKaiActionAvailability,
  getKaiActionById,
  listKaiActionsForSurface,
  searchKaiActions,
  type KaiActionDefinition,
} from "@/lib/voice/kai-action-gateway";
import {
  isDiscoverableCapability,
  projectKaiActionCapability,
  type VoiceCapabilityStateV1,
} from "@/lib/voice/capability-projection";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { Icon } from "@/lib/morphy-ux/ui";

export type KaiCommandPaletteSelection = {
  actionId: string;
  slots?: Record<string, unknown>;
};

interface KaiCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectAction: (selection: KaiCommandPaletteSelection) => void;
  onSubmitPrompt: (prompt: string) => void;
  appRuntimeState?: AppRuntimeState;
  capabilityState?: VoiceCapabilityStateV1;
  surfaceMetadata?: VoiceSurfaceMetadata | null;
  disabled?: boolean;
  portfolioTickers?: Array<{
    symbol: string;
    name?: string;
    sector?: string;
    asset_type?: string;
    is_investable?: boolean;
    analyze_eligible?: boolean;
  }>;
  topMover?: {
    symbol: string;
    companyName?: string | null;
  } | null;
}

export type InitialCommandRecommendation = {
  actionId: string;
  category: "Research" | "Memory" | "Consent" | "Account";
  label: string;
  slots?: Record<string, string>;
};

/**
 * How many of the current screen's own actions the unfiltered palette offers
 * before it falls back to the app-wide suggestions. Location alone declares
 * seventeen; listing them all would bury everything else in the dialog.
 */
const ON_SCREEN_ACTION_LIMIT = 6;

/**
 * True when running `action` would land exactly where the person already is.
 *
 * A route action names its destination as a path plus, for surfaces whose tabs
 * and flows live in the query string, one of the params `deriveVoiceRouteScreen`
 * reads back as the subview. Comparing both is what keeps "Open Location now"
 * out of the list while you are standing on the Location Now tab -- the single
 * suggestion that would most make search look unaware of its surroundings.
 */
export function actionTargetsCurrentSurface(
  action: KaiActionDefinition,
  pathname: string,
  subview: string | null,
): boolean {
  const target = action.execution_target;
  if (target.status !== "wired" || target.path !== "route") return false;
  const [targetPath, targetQuery] = String(target.target || "").split("?");
  if (targetPath !== pathname) return false;
  if (!targetQuery) return !subview;
  const params = new URLSearchParams(targetQuery);
  const targetSubview =
    params.get("action") || params.get("view") || params.get("tab");
  return Boolean(targetSubview) && targetSubview === subview;
}

/**
 * The empty command palette is a short, varied next-step list rather than a
 * full action directory. The first choice uses the same cached market mover
 * already surfaced on One; this helper intentionally does not fetch data.
 */
export function buildInitialCommandRecommendations(input: {
  topMover?: { symbol: string; companyName?: string | null } | null;
}): InitialCommandRecommendation[] {
  const symbol = String(input.topMover?.symbol || "").trim().toUpperCase();
  const companyName = String(input.topMover?.companyName || "").trim();
  const analysisLabel = symbol
    ? `Analyze ${symbol}${companyName ? ` · ${companyName}` : ""}`
    : "Start stock analysis";

  return [
    {
      actionId: "analysis.start",
      category: "Research",
      label: analysisLabel,
      ...(symbol ? { slots: { symbol } } : {}),
    },
    {
      actionId: "route.one_pkm",
      category: "Memory",
      label: "Open Memory",
    },
    {
      actionId: "route.consents",
      category: "Consent",
      label: "Review consent requests",
    },
    {
      actionId: "route.profile",
      category: "Account",
      label: "Open Profile",
    },
  ];
}

function isPortfolioAnalyzeEligible(row: {
  is_investable?: boolean;
  analyze_eligible?: boolean;
  asset_type?: string;
}): boolean {
  if (typeof row.analyze_eligible === "boolean") return row.analyze_eligible;
  if (row.is_investable !== true) return false;
  const assetType = String(row.asset_type || "").toLowerCase();
  if (
    assetType.includes("cash") ||
    assetType.includes("sweep") ||
    assetType.includes("bond") ||
    assetType.includes("fixed income")
  ) {
    return false;
  }
  return true;
}

function isLikelySecCommonEquityRow(row: TickerUniverseRow): boolean {
  if (row.tradable === false) return false;
  const ticker = String(row.ticker || "").trim().toUpperCase();
  if (!ticker) return false;

  const combined = [
    String(row.title || ""),
    String(row.sector || row.sector_primary || ""),
    String(row.industry || row.industry_primary || ""),
    String(row.sic_description || ""),
  ]
    .join(" ")
    .toLowerCase();

  if (ticker.endsWith("X")) return false;
  if (
    /(?:\betf\b|\bfund\b|\bmutual\b|\btrust\b|\bmoney market\b|\bcash\b|\bsweep\b|\bbond\b|\bfixed income\b|\btreasury\b|\bmunicipal\b|\breit\b|\bcommodity\b|\bgold\b)/i.test(
      combined
    )
  ) {
    return false;
  }
  return true;
}

const GENERIC_SECTOR_LABELS = new Set([
  "equity",
  "equities",
  "stock",
  "stocks",
  "other",
  "unknown",
  "unclassified",
  "n/a",
]);

function toNonEmpty(value: unknown): string | undefined {
  const text = String(value || "").trim();
  return text ? text : undefined;
}

function isSpecificSectorLabel(value: unknown): boolean {
  const text = toNonEmpty(value);
  if (!text) return false;
  return !GENERIC_SECTOR_LABELS.has(text.toLowerCase());
}

function pickPreferredLabel(values: Array<unknown>): string | undefined {
  let fallback: string | undefined;
  for (const value of values) {
    const text = toNonEmpty(value);
    if (!text) continue;
    if (!fallback) fallback = text;
    if (isSpecificSectorLabel(text)) {
      return text;
    }
  }
  return fallback;
}

function rankTickerRow(row: TickerUniverseRow, qUpper: string): number {
  const prefixBoost = String(row.ticker || "")
    .toUpperCase()
    .startsWith(qUpper)
    ? 1000
    : 0;
  const confidence = Number(row.metadata_confidence || 0) * 100;
  const sectorBoost = isSpecificSectorLabel(row.sector || row.sector_primary) ? 20 : 0;
  const exchangeBoost =
    toNonEmpty(row.exchange) && String(row.exchange).toLowerCase() !== "portfolio" ? 5 : 0;
  return prefixBoost + confidence + sectorBoost + exchangeBoost;
}

export function KaiCommandPalette({
  open,
  onOpenChange,
  onSelectAction,
  onSubmitPrompt,
  appRuntimeState,
  capabilityState,
  surfaceMetadata,
  disabled = false,
  portfolioTickers = [],
  topMover = null,
}: KaiCommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [universe, setUniverse] = useState<TickerUniverseRow[] | null>(
    getTickerUniverseSnapshot()
  );
  const [loadingUniverse, setLoadingUniverse] = useState<boolean>(!universe);
  const [remoteMatches, setRemoteMatches] = useState<TickerUniverseRow[]>([]);
  const [universeError, setUniverseError] = useState<string | null>(null);
  const [remoteSearchError, setRemoteSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setLoadingUniverse(false);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        setLoadingUniverse(true);
        setUniverseError(null);
        const rows = await preloadTickerUniverse();
        if (!cancelled) {
          setUniverse(rows);
        }
      } catch (error) {
        if (!cancelled) {
          setUniverse((prev) => prev ?? []);
          setUniverseError(
            error instanceof Error ? error.message : "Failed to load ticker universe"
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingUniverse(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setRemoteMatches([]);
      setRemoteSearchError(null);
      return;
    }

    let cancelled = false;
    const q = query.trim();
    if (q.length < 2) {
      setRemoteMatches([]);
      setRemoteSearchError(null);
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const rows = await searchTickerUniverseRemote(q, 20);
          if (!cancelled) {
            setRemoteMatches(rows);
            setRemoteSearchError(null);
          }
        } catch (error) {
          if (!cancelled) {
            setRemoteMatches([]);
            setRemoteSearchError(
              error instanceof Error ? error.message : "Ticker search failed"
            );
          }
        }
      })();
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const universeByTicker = useMemo(() => {
    const map = new Map<string, TickerUniverseRow>();
    const rows = universe ?? [];
    for (const row of rows) {
      const ticker = String(row.ticker || "").trim().toUpperCase();
      if (!ticker) continue;
      map.set(ticker, row);
    }
    return map;
  }, [universe]);

  const portfolioRows = useMemo<TickerUniverseRow[]>(() => {
    const deduped = new Map<string, TickerUniverseRow>();
    for (const row of portfolioTickers) {
      const symbol = String(row.symbol || "").trim().toUpperCase();
      if (!symbol) continue;
      if (!isPortfolioAnalyzeEligible(row)) continue;
      if (deduped.has(symbol)) continue;
      const enriched = universeByTicker.get(symbol);
      const preferredSector = pickPreferredLabel([
        enriched?.sector,
        enriched?.sector_primary,
        row.sector,
        row.asset_type,
      ]);
      deduped.set(symbol, {
        ticker: symbol,
        title:
          toNonEmpty(row.name) ||
          toNonEmpty(enriched?.title) ||
          "Portfolio holding",
        sector_primary: preferredSector,
        sector: preferredSector,
        industry_primary: toNonEmpty(enriched?.industry || enriched?.industry_primary),
        exchange: toNonEmpty(enriched?.exchange) || "Portfolio",
        metadata_confidence:
          typeof enriched?.metadata_confidence === "number"
            ? enriched.metadata_confidence
            : 1,
        tradable: true,
      });
    }
    return Array.from(deduped.values());
  }, [portfolioTickers, universeByTicker]);

  const portfolioTickerSet = useMemo(() => {
    return new Set(portfolioRows.map((row) => row.ticker));
  }, [portfolioRows]);

  const tickerMatches = useMemo(() => {
    const rows = universe ?? [];
    const search = query.trim();
    const mergeAndNormalizeRows = (
      candidates: TickerUniverseRow[],
      qUpper: string
    ): TickerUniverseRow[] => {
      const byTicker = new Map<string, TickerUniverseRow>();
      for (const row of candidates) {
        const ticker = String(row.ticker || "").trim().toUpperCase();
        if (!ticker) continue;
        const normalized: TickerUniverseRow = {
          ...row,
          ticker,
          sector: pickPreferredLabel([row.sector, row.sector_primary]),
          sector_primary: pickPreferredLabel([row.sector_primary, row.sector]),
        };
        const existing = byTicker.get(ticker);
        if (
          !existing ||
          rankTickerRow(normalized, qUpper) > rankTickerRow(existing, qUpper)
        ) {
          byTicker.set(ticker, normalized);
        }
      }
      return Array.from(byTicker.values()).filter((row) => row.tradable !== false);
    };

    if (!search) {
      const mergedDefaultRows = mergeAndNormalizeRows(
        [...portfolioRows, ...rows.filter((row) => isLikelySecCommonEquityRow(row))],
        ""
      );
      return mergedDefaultRows
        .sort((a, b) => {
          const aPortfolio = portfolioTickerSet.has(a.ticker) ? 1 : 0;
          const bPortfolio = portfolioTickerSet.has(b.ticker) ? 1 : 0;
          if (aPortfolio !== bPortfolio) return bPortfolio - aPortfolio;
          const aScore = Number(a.metadata_confidence || 0);
          const bScore = Number(b.metadata_confidence || 0);
          if (aScore !== bScore) return bScore - aScore;
          return a.ticker.localeCompare(b.ticker);
        })
        .slice(0, 20);
    }

    const searchUpper = search.toUpperCase();
    const portfolioMatches = portfolioRows.filter((row) => {
      const title = String(row.title || "").toLowerCase();
      return row.ticker.includes(searchUpper) || title.includes(search.toLowerCase());
    });
    const local = searchTickerUniverse(rows, search, 20).filter((row) =>
      isLikelySecCommonEquityRow(row)
    );
    const merged = [...portfolioMatches, ...local];
    for (const row of remoteMatches) {
      if (!isLikelySecCommonEquityRow(row)) continue;
      merged.push(row);
    }
    return mergeAndNormalizeRows(merged, searchUpper)
      .sort((a, b) => {
        const aPrefix = a.ticker.startsWith(searchUpper) ? 1 : 0;
        const bPrefix = b.ticker.startsWith(searchUpper) ? 1 : 0;
        if (aPrefix !== bPrefix) return bPrefix - aPrefix;
        const aScore = Number(a.metadata_confidence || 0);
        const bScore = Number(b.metadata_confidence || 0);
        if (aScore !== bScore) return bScore - aScore;
        return a.ticker.localeCompare(b.ticker);
      })
      .slice(0, 20);
  }, [portfolioRows, portfolioTickerSet, query, universe, remoteMatches]);

  const isFiltering = query.trim().length > 0;
  const commandEmptyMessage = loadingUniverse
    ? "Loading commands..."
    : universeError
      ? "Ticker universe unavailable. Check backend connectivity."
      : "No matching commands.";

  const actionMatches = useMemo(
    () =>
      searchKaiActions({
        query,
        appRuntimeState,
        surfaceMetadata,
        limit: 24,
      }).filter((entry) => {
        if (!capabilityState) return true;
        return isDiscoverableCapability(
          projectKaiActionCapability({
            actionId: entry.action.action_id,
            state: capabilityState,
            surfaceMetadata,
          }),
        );
      }),
    [appRuntimeState, capabilityState, query, surfaceMetadata]
  );

  /**
   * What the screen the person is looking at can actually do, read straight
   * from the action gateway.
   *
   * The unfiltered palette used to offer nothing but `buildInitialCommand-
   * Recommendations` -- an authored four-item Kai list -- so opening search
   * anywhere in the app suggested stock analysis and Memory however far those
   * were from the surface in view. This group answers "what can I do here"
   * instead, and stays current for free: a surface that authors a new action
   * in its voice contract shows up here with no change to this file.
   */
  const onScreenActions = useMemo(() => {
    const screen = String(appRuntimeState?.route.screen || "").trim();
    // `route.pathname` carries the query string as well -- the runtime state
    // builder feeds it `pathnameWithQuery` -- so the path has to be split back
    // out before it can be compared with a contract's route target.
    const pathname =
      String(appRuntimeState?.route.pathname || "")
        .trim()
        .split("?")[0] || "";
    const subview = String(appRuntimeState?.route.subview || "").trim() || null;
    if (!screen && !pathname) return [];
    return listKaiActionsForSurface({ screen, pathname })
      .filter((action) => !actionTargetsCurrentSurface(action, pathname, subview))
      .map((action) => ({
        action,
        availability: evaluateKaiActionAvailability({
          action,
          appRuntimeState,
          surfaceMetadata,
        }),
      }))
      .filter(({ action, availability }) => {
        // Unlike the typed-query list, which shows a blocked action together
        // with the reason it is blocked, this group is a menu of what is
        // possible right now -- an entry that cannot run does not belong in it.
        if (availability.status !== "available") return false;
        if (!capabilityState) return true;
        return isDiscoverableCapability(
          projectKaiActionCapability({
            actionId: action.action_id,
            state: capabilityState,
            surfaceMetadata,
          }),
        );
      })
      .slice(0, ON_SCREEN_ACTION_LIMIT);
  }, [appRuntimeState, capabilityState, surfaceMetadata]);

  const initialRecommendations = useMemo(
    () =>
      buildInitialCommandRecommendations({ topMover }).flatMap(
        (recommendation) => {
          const action = getKaiActionById(recommendation.actionId);
          if (!action) return [];
          const availability = evaluateKaiActionAvailability({
            action,
            appRuntimeState,
            surfaceMetadata,
          });
          const unavailable =
            availability.status === "dead" ||
            availability.status === "unwired" ||
            availability.status === "manual_only" ||
            availability.status === "blocked";
          if (unavailable) return [];
          if (
            capabilityState &&
            !isDiscoverableCapability(
              projectKaiActionCapability({
                actionId: action.action_id,
                state: capabilityState,
                surfaceMetadata,
              }),
            )
          ) {
            return [];
          }
          return [{ ...recommendation, action }];
        },
      ),
    [appRuntimeState, capabilityState, surfaceMetadata, topMover],
  );

  const exactActionMatch = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return null;
    return actionMatches.find(({ action }) =>
      [action.action_id, action.label, ...action.aliases].some(
        (value) => value.trim().toLowerCase() === normalized,
      ),
    );
  }, [actionMatches, query]);

  function runAction(actionId: string, slots?: Record<string, unknown>) {
    if (disabled) return;
    onOpenChange(false);
    setQuery("");
    onSelectAction({
      actionId,
      slots,
    });
  }

  function submitSearchOrPrompt(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const value = query.trim();
    if (!value) return;
    if (exactActionMatch) {
      runAction(exactActionMatch.action.action_id);
      return;
    }
    onOpenChange(false);
    setQuery("");
    onSubmitPrompt(value);
  }

  function submitPromptSuggestion() {
    if (disabled) return;
    const value = query.trim();
    if (!value) return;
    onOpenChange(false);
    setQuery("");
    onSubmitPrompt(value);
  }

  const commandItemClass =
    "rounded-lg border border-transparent transition-colors duration-300 hover:bg-primary/10 hover:text-foreground data-[selected=true]:border-primary/25 data-[selected=true]:bg-primary/15 data-[selected=true]:text-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45";

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      showCloseButton={false}
      title="Search or ask One"
      data-keyboard-anchor="bottom"
      className="top-auto bottom-[calc(var(--kb-height,0px)+0.5rem)] max-h-[min(calc(100dvh-var(--kb-height,0px)-1rem),34rem)] w-[calc(100%-1rem)] max-sm:!translate-y-0 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-h-none sm:-translate-y-1/2"
    >
      <CommandList className="max-h-[min(56dvh,24rem)] sm:max-h-[300px]">
        <CommandEmpty className={isFiltering ? undefined : "hidden"}>{commandEmptyMessage}</CommandEmpty>

        <CommandGroup
          heading="On this screen"
          hidden={isFiltering || onScreenActions.length === 0}
        >
          {onScreenActions.map(({ action }) => (
            <CommandItem
              className={commandItemClass}
              key={action.action_id}
              disabled={disabled}
              value={[
                action.label,
                action.action_id,
                action.aliases.join(" "),
                action.search_keywords.join(" "),
              ].join(" ")}
              onSelect={() => runAction(action.action_id)}
            >
              <Icon
                icon={Compass}
                size="sm"
                className="mr-2 text-muted-foreground"
              />
              <span className="min-w-0 truncate font-medium">
                {action.label}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Suggested actions" hidden={isFiltering}>
          {initialRecommendations.map(({ action, actionId, category, label, slots }) => {
            const icon =
              category === "Research"
                ? TrendingUp
                : category === "Memory"
                  ? History
                  : category === "Consent"
                    ? ShieldCheck
                    : UserRound;
            return (
              <CommandItem
                className={commandItemClass}
                key={actionId}
                disabled={disabled}
                value={`${label} ${category} ${action.action_id}`}
                onSelect={() => runAction(actionId, slots)}
              >
                <Icon icon={icon} size="sm" className="mr-2 text-muted-foreground" />
                <span className="min-w-0 truncate font-medium">{label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandGroup heading="Ask One" hidden={!isFiltering}>
          <CommandItem
            className={commandItemClass}
            value={`Ask One ${query}`}
            disabled={disabled}
            onSelect={submitPromptSuggestion}
          >
            <Icon icon={Search} size="sm" className="mr-2 text-accent-strong" />
            <span className="min-w-0 truncate font-medium">
              Ask One: {query.trim()}
            </span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator hidden={!isFiltering} />

        <CommandGroup heading="Commands" hidden={!isFiltering}>
          {actionMatches.length === 0 ? (
            <CommandItem className={commandItemClass} disabled>
              <Icon icon={Compass} size="sm" className="mr-2 text-muted-foreground" />
              No matching Kai actions.
            </CommandItem>
          ) : null}
          {actionMatches.map(({ action, availability }) => {
            const actionDisabled =
              disabled ||
              availability.status === "dead" ||
              availability.status === "unwired" ||
              availability.status === "manual_only" ||
              availability.status === "blocked";
            const icon =
              action.action_id === "route.profile"
                ? UserRound
                : action.action_id === "route.consents"
                  ? ShieldCheck
                  : action.action_id === "route.analysis_history"
                    ? History
                    : action.action_id === "route.kai_home"
                      ? Compass
                      : Activity;
            return (
              <CommandItem
                className={commandItemClass}
                key={action.action_id}
                disabled={actionDisabled}
                value={[
                  action.label,
                  action.action_id,
                  action.aliases.join(" "),
                  action.search_keywords.join(" "),
                ].join(" ")}
                onSelect={() => runAction(action.action_id)}
              >
                <Icon icon={icon} size="sm" className="mr-2 text-muted-foreground" />
                <span className="font-medium">{action.label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator hidden={!isFiltering} />

        <CommandGroup heading="Market results" hidden={!isFiltering}>
          {universeError ? (
            <CommandItem className={commandItemClass} disabled>
              Ticker universe unavailable.
            </CommandItem>
          ) : null}
          {remoteSearchError && isFiltering ? (
            <CommandItem className={commandItemClass} disabled>
              Live ticker search failed.
            </CommandItem>
          ) : null}
          {!loadingUniverse && tickerMatches.length === 0 && (
            <CommandItem className={commandItemClass} disabled>
              No matching SEC common equity tickers.
            </CommandItem>
          )}
          {tickerMatches.map((row) => {
            const ticker = row.ticker.toUpperCase();
            const title = row.title || "Unknown company";
            return (
              <CommandItem
                className={commandItemClass}
                key={`${ticker}:${title}`}
                disabled={disabled}
                value={`${ticker} ${title} ${row.sector || row.sector_primary || ""} ${row.exchange || ""}`}
                onSelect={() =>
                  runAction("analysis.start", {
                    symbol: ticker,
                  })
                }
              >
                <Icon icon={TrendingUp} size="sm" className="mr-2 text-muted-foreground" />
                <span className="font-semibold">{ticker}</span>
                <span className="ml-2 text-xs text-muted-foreground truncate">
                  {title}
                  {row.sector || row.sector_primary
                    ? ` • ${row.sector || row.sector_primary}`
                    : ""}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
      <div className="relative border-t border-border/70">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          onKeyDown={submitSearchOrPrompt}
          disabled={disabled}
          placeholder="Ask One or search"
          className="pr-28"
          enterKeyHint="send"
          autoFocus
        />
        <div className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          <button
            type="button"
            aria-label="Close search"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black/[0.045] hover:text-foreground dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>
      </div>
    </CommandDialog>
  );
}

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
  Lightbulb,
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
import { navigationActionForRoute } from "@/lib/voice/navigation-journey";
import {
  isDiscoverableCapability,
  projectKaiActionCapability,
  type VoiceCapabilityStateV1,
} from "@/lib/voice/capability-projection";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { KAI_MARKET_PATH, ROUTES } from "@/lib/navigation/routes";
import type { KaiCommandBarIntent } from "@/lib/navigation/kai-command-bar-events";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";
import {
  RECENT_ACTION_LIMIT,
  readActionUsage,
  recordActionUse,
  usageBoostFor,
  type ActionUsageEntry,
} from "@/lib/voice/action-usage-memory";

export type KaiCommandPaletteSelection = {
  actionId: string;
  slots?: Record<string, unknown>;
};

interface KaiCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectAction: (selection: KaiCommandPaletteSelection) => void;
  onSubmitPrompt: (prompt: string) => void;
  intent?: KaiCommandBarIntent;
  initialQuery?: string;
  appRuntimeState?: AppRuntimeState;
  capabilityState?: VoiceCapabilityStateV1;
  surfaceMetadata?: VoiceSurfaceMetadata | null;
  /** Scopes usage memory per account; a shared device must not blend habits. */
  userId?: string | null;
  disabled?: boolean;
  portfolioTickers?: Array<{
    symbol: string;
    name?: string;
    sector?: string;
    asset_type?: string;
    is_investable?: boolean;
    analyze_eligible?: boolean;
  }>;
}

const ANALYZE_PREFIX = "Analyze ";

export function isFinanceAnalysisQuery(query: string): boolean {
  return /^analyze(?:\s|$)/i.test(query.trimStart());
}

export function deriveFinanceTickerQuery(
  query: string,
  intent?: KaiCommandBarIntent,
): string {
  const trimmed = query.trim();
  if (intent !== "finance_stock_analysis" && !isFinanceAnalysisQuery(query)) {
    return trimmed;
  }
  if (!trimmed.toLowerCase().startsWith("analyze")) return trimmed;
  return trimmed.slice("analyze".length).trim();
}


/**
 * How many rows each unfiltered group offers. Location alone declares
 * nineteen actions; listing every one would bury the other group entirely.
 * The list scrolls, so this is about what reads at a glance rather than about
 * what is reachable -- anything cut here is still one typed word away.
 */
const GROUP_LIMIT = 6;

/**
 * Control ids currently present and enabled in the document.
 *
 * These are the `data-voice-control-id` anchors surfaces put on their own
 * buttons. An action whose control is here is one the person can already tap,
 * which is what separates "things you cannot reach from this view" from "the
 * basics of this screen".
 *
 * Exported for its test; it is a DOM read, so it is deliberately not a hook.
 */
export function readTappableControlIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  if (typeof document === "undefined") return ids;
  document
    .querySelectorAll<HTMLElement>("[data-voice-control-id]")
    .forEach((element) => {
      const id = (element.dataset.voiceControlId || "").trim();
      if (!id) return;
      // A disabled control is on screen but not tappable, so the action behind
      // it is still worth offering as a row.
      if (element.hasAttribute("disabled")) return;
      if (element.getAttribute("aria-disabled") === "true") return;
      ids.add(id);
    });
  return ids;
}

/**
 * The action that opens the screen `action` lives on, if one exists.
 *
 * A local handler is only runnable where it is mounted, so reaching one from
 * elsewhere means going there first. Resolved from the contracts rather than
 * named here, so a new destination needs no change to this file.
 */
export function navigationActionForAction(
  action: KaiActionDefinition,
): string | null {
  for (const route of action.reachability.routes) {
    const navigationActionId = navigationActionForRoute(route);
    if (navigationActionId && navigationActionId !== action.action_id) {
      return navigationActionId;
    }
  }
  return null;
}

/**
 * True when `action` can only run on a screen the person is not standing on.
 *
 * A `local_handler` executes through a callback the owning screen registers
 * while it is mounted. Invoked from anywhere else the runtime finds no handler
 * and returns `blocked`, which the palette does not surface -- so the row
 * looks live, does nothing, and explains nothing.
 *
 * Navigation is deliberately exempt: a route action's whole job is to take the
 * person somewhere, so it is runnable from wherever they happen to be.
 */
export function isLocalHandlerAwayFromItsScreen(
  action: KaiActionDefinition,
  screen: string | null,
): boolean {
  const target = action.execution_target;
  if (target.status !== "wired" || target.path !== "local_handler") return false;
  const screens = action.reachability.screens;
  if (screens.length === 0) return false;
  return !screen || !screens.includes(screen);
}

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
  intent,
  initialQuery,
  appRuntimeState,
  capabilityState,
  surfaceMetadata,
  userId = null,
  disabled = false,
  portfolioTickers = [],
}: KaiCommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [universe, setUniverse] = useState<TickerUniverseRow[] | null>(
    getTickerUniverseSnapshot()
  );
  const [loadingUniverse, setLoadingUniverse] = useState<boolean>(!universe);
  const [remoteMatches, setRemoteMatches] = useState<TickerUniverseRow[]>([]);
  const [universeError, setUniverseError] = useState<string | null>(null);
  const [remoteSearchError, setRemoteSearchError] = useState<string | null>(null);

  /**
   * Ticker rows belong to Finance, not to every screen in the app.
   *
   * The palette began life on the Kai home and kept offering SEC ticker
   * matches after it became global chrome, so searching on Location answered
   * with equities. Keyed on the route rather than a hand-listed set of screen
   * ids so it cannot drift.
   */
  const currentScreen = useMemo(
    () => String(appRuntimeState?.route.screen || "").trim() || null,
    [appRuntimeState],
  );

  const financeSectionActive = useMemo(() => {
    const pathname = String(appRuntimeState?.route.pathname || "").trim();
    return (
      pathname === KAI_MARKET_PATH ||
      pathname.startsWith(`${KAI_MARKET_PATH}/`) ||
      pathname.startsWith(`${KAI_MARKET_PATH}?`) ||
      pathname === ROUTES.LEGACY_KAI_HOME ||
      pathname.startsWith(`${ROUTES.LEGACY_KAI_HOME}/`)
    );
  }, [appRuntimeState]);
  // The Analysis button supplies the authored intent, while a person typing
  // the same authored `Analyze ` command into global Search must enter the
  // identical stock workflow. This is command parsing, not semantic keyword
  // inference: only the exact prefix changes the palette's authority.
  const financeAnalysisIntent =
    intent === "finance_stock_analysis" || isFinanceAnalysisQuery(query);
  const financeTickerQuery = useMemo(
    () => deriveFinanceTickerQuery(query, intent),
    [intent, query],
  );

  useEffect(() => {
    if (!open) return;
    setQuery(
      initialQuery ?? (intent === "finance_stock_analysis" ? ANALYZE_PREFIX : ""),
    );
  }, [initialQuery, intent, open]);

  useEffect(() => {
    // The ticker universe is Finance's data. The palette began life on the Kai
    // home and kept fetching it after it became global chrome, so opening
    // search on Location paid for an equities index it would never show -- and
    // surfaced "Ticker universe unavailable" on screens that have no tickers.
    if (!open || (!financeSectionActive && !financeAnalysisIntent)) {
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
  }, [open, financeAnalysisIntent, financeSectionActive]);

  useEffect(() => {
    if (!open || (!financeSectionActive && !financeAnalysisIntent)) {
      setRemoteMatches([]);
      setRemoteSearchError(null);
      return;
    }

    let cancelled = false;
    const q = financeTickerQuery;
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
  }, [open, financeAnalysisIntent, financeTickerQuery, financeSectionActive]);

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
    const search = financeTickerQuery;
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
  }, [financeTickerQuery, portfolioRows, portfolioTickerSet, universe, remoteMatches]);

  const isFiltering = query.trim().length > 0;
  // Only Finance loads the ticker universe, so only Finance can report it as
  // slow or unavailable. Elsewhere those messages described a subsystem the
  // screen never asked for.
  const commandEmptyMessage =
    (financeSectionActive || financeAnalysisIntent) && loadingUniverse
      ? "Loading commands..."
      : (financeSectionActive || financeAnalysisIntent) && universeError
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
        // A typed query searches the whole app, so an action belonging to
        // another screen stays in the results. What it must NOT do is sit
        // there looking live and do nothing -- a local handler only runs while
        // the screen that registered it is mounted, which is how "Answer
        // Investment Horizon" came to be a dead row on Location. Those are
        // kept only when something can actually walk the person there; see
        // `resolveRunTarget`.
        if (
          isLocalHandlerAwayFromItsScreen(entry.action, currentScreen) &&
          !navigationActionForAction(entry.action)
        ) {
          return false;
        }
        if (!capabilityState) return true;
        return isDiscoverableCapability(
          projectKaiActionCapability({
            actionId: entry.action.action_id,
            state: capabilityState,
            surfaceMetadata,
          }),
        );
      }),
    [appRuntimeState, capabilityState, currentScreen, query, surfaceMetadata]
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
  /**
   * Control ids the person can literally tap right now, read off the DOM.
   *
   * Captured when the palette opens, because it describes the page underneath
   * and that page can change between openings. A dialog leaves the rest of the
   * document mounted, so the query still sees it.
   */
  const [tappableControlIds, setTappableControlIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [usage, setUsage] = useState<readonly ActionUsageEntry[]>([]);
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    setTappableControlIds(readTappableControlIds());
    setUsage(readActionUsage(userId));
  }, [open, userId]);

  const surfaceActions = useMemo(() => {
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
        // Offering something whose button is already on screen spends a slot
        // on what the person can see. That is the split between the two
        // groups: what you cannot reach from here, and what you can.
        tappable: action.control_ids.some((id) => tappableControlIds.has(id)),
      }))
      .filter(({ action, availability }) => {
        // Unlike the typed-query list, which shows a blocked action together
        // with the reason it is blocked, these groups are a menu of what is
        // possible right now -- an entry that cannot run does not belong.
        if (availability.status !== "available") return false;
        if (!capabilityState) return true;
        return isDiscoverableCapability(
          projectKaiActionCapability({
            actionId: action.action_id,
            state: capabilityState,
            surfaceMetadata,
          }),
        );
      });
  }, [
    appRuntimeState,
    capabilityState,
    surfaceMetadata,
    tappableControlIds,
  ]);

  /**
   * What this screen can do that the person cannot already see.
   *
   * The other tabs, the deeper flows, the things behind a tab switch. Anything
   * with a button in front of them belongs in the suggestions below, not here
   * -- offering "Share my location" while a Share location row is on screen is
   * a wasted slot.
   */
  const offScreenActions = useMemo(
    () => surfaceActions.filter((entry) => !entry.tappable).slice(0, GROUP_LIMIT),
    [surfaceActions],
  );

  /**
   * The same matches, with what this person actually uses breaking ties.
   *
   * `searchKaiActions` has already ranked by how well each action answers the
   * query; this only separates entries that answered it equally well. The
   * boost is capped so a familiar action can never displace a better answer --
   * typing "circle" must find Create a circle whether or not you have ever
   * created one.
   */
  const rankedActionMatches = useMemo(() => {
    if (usage.length === 0) return actionMatches;
    return [...actionMatches].sort(
      (left, right) =>
        usageBoostFor(usage, right.action.action_id) -
        usageBoostFor(usage, left.action.action_id),
    );
  }, [actionMatches, usage]);

  /**
   * What this person reaches for, offered before anything the app guessed.
   *
   * Filtered through the same availability and capability rules as every other
   * group -- a habit is not a reason to offer something that cannot run -- and
   * excludes whatever is already a button in front of them.
   */
  const recentActions = useMemo(() => {
    if (usage.length === 0) return [];
    const rows: KaiActionDefinition[] = [];
    for (const entry of usage) {
      if (rows.length >= RECENT_ACTION_LIMIT) break;
      const action = getKaiActionById(entry.actionId);
      if (!action) continue;
      if (action.control_ids.some((id) => tappableControlIds.has(id))) continue;
      if (isLocalHandlerAwayFromItsScreen(action, currentScreen)) continue;
      const availability = evaluateKaiActionAvailability({
        action,
        appRuntimeState,
        surfaceMetadata,
      });
      if (availability.status !== "available") continue;
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
        continue;
      }
      rows.push(action);
    }
    return rows;
  }, [
    appRuntimeState,
    capabilityState,
    currentScreen,
    surfaceMetadata,
    tappableControlIds,
    usage,
  ]);

  /**
   * What the app has noticed and thinks is worth doing next.
   *
   * The insight comes first: a surface that has published a dead end is
   * telling us it cannot proceed without something done elsewhere, and the
   * remedy it names is the single most useful row the palette can offer. Then
   * anything blocked with authored guidance, then the section's own basics --
   * which are exactly the controls visible on this screen.
   *
   * This replaced a hardcoded four (analyze a stock, Memory, consent, profile)
   * that were shown on every screen in the app regardless of context.
   */
  const suggestedActions = useMemo(() => {
    const suggestions: Array<{
      action: KaiActionDefinition;
      note: string | null;
    }> = [];
    const seen = new Set<string>();
    const push = (action: KaiActionDefinition | null, note: string | null) => {
      if (!action || seen.has(action.action_id)) return;
      seen.add(action.action_id);
      suggestions.push({ action, note });
    };

    const deadEnd = surfaceMetadata?.deadEnd;
    if (deadEnd?.remedyActionId && deadEnd.reason) {
      push(getKaiActionById(deadEnd.remedyActionId), deadEnd.reason);
    }
    surfaceActions.forEach(({ action, availability }) => {
      if (availability.blocked_guidance) {
        push(action, availability.blocked_guidance);
      }
    });
    surfaceActions.forEach(({ action, tappable }) => {
      if (tappable) push(action, null);
    });
    return suggestions.slice(0, GROUP_LIMIT);
  }, [surfaceActions, surfaceMetadata]);


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
    // The id only, and only what the person actually chose -- not what was
    // merely offered, and never the slots that would turn a habit into a
    // holding.
    recordActionUse(userId, actionId);
    onOpenChange(false);
    setQuery("");
    // A local handler belonging to another screen cannot run from here: the
    // runtime finds nothing mounted and reports `blocked`, which the palette
    // never surfaced, so the row simply did nothing. Search covers the whole
    // app, so the honest answer is to take the person to the screen that owns
    // it rather than to hide the row or fail silently.
    const action = getKaiActionById(actionId);
    if (action && isLocalHandlerAwayFromItsScreen(action, currentScreen)) {
      const navigationActionId = navigationActionForAction(action);
      if (navigationActionId) {
        onSelectAction({ actionId: navigationActionId });
        return;
      }
    }
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
    if (financeAnalysisIntent) {
      const soleMatch = tickerMatches.length === 1 ? tickerMatches[0] : null;
      if (soleMatch) {
        runAction("analysis.start", { symbol: soleMatch.ticker.toUpperCase() });
      }
      return;
    }
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
      className="top-auto bottom-[calc(var(--kb-height,0px)+var(--bottom-chrome-stack-height,0px)+0.5rem)] max-h-[min(calc(100dvh-var(--kb-height,0px)-var(--bottom-chrome-stack-height,0px)-1rem),34rem)] w-[calc(100%-1rem)] max-sm:!translate-y-0 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-h-none sm:-translate-y-1/2"
    >
      <CommandList className="max-h-[min(56dvh,24rem)] sm:max-h-[300px]">
        <CommandEmpty className={isFiltering ? undefined : "hidden"}>{commandEmptyMessage}</CommandEmpty>

        {/* Both unfiltered groups are RENDERED conditionally rather than
            passed `hidden`. cmdk owns filtering, so it re-scores every mounted
            item against the query and decides each group's visibility from
            whether any child still matches -- which overrode `hidden` and left
            this group on screen, full of fuzzy matches, pushing the real
            results below the fold. A group that is not in the tree cannot be
            resurrected. */}
        {!isFiltering && recentActions.length > 0 ? (
          <CommandGroup heading="You usually">
            {recentActions.map((action) => (
              <CommandItem
                className={commandItemClass}
                key={`recent-${action.action_id}`}
                disabled={disabled}
                value={action.action_id}
                onSelect={() => runAction(action.action_id)}
              >
                <Icon
                  icon={History}
                  size="sm"
                  className="mr-2 text-muted-foreground"
                />
                <span className="min-w-0 truncate font-medium">
                  {action.label}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {!isFiltering && offScreenActions.length > 0 ? (
          <CommandGroup heading="Elsewhere on this screen">
            {offScreenActions.map(({ action }) => (
              <CommandItem
                className={commandItemClass}
                key={action.action_id}
                disabled={disabled}
                value={action.action_id}
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
        ) : null}

        {!isFiltering && suggestedActions.length > 0 ? (
          <CommandGroup heading="Suggested actions">
            {suggestedActions.map(({ action, note }) => (
              <CommandItem
                className={commandItemClass}
                key={action.action_id}
                disabled={disabled}
                value={action.action_id}
                onSelect={() => runAction(action.action_id)}
              >
                <Icon
                  icon={note ? Lightbulb : Compass}
                  size="sm"
                  className={cn(
                    "mr-2",
                    note ? "text-accent-strong" : "text-muted-foreground",
                  )}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="min-w-0 truncate font-medium">
                    {action.label}
                  </span>
                  {/* The reason a surface published a dead end, said back to
                      the person. Without it the remedy is a bare link and they
                      have to guess why it is being offered. */}
                  {note ? (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {note}
                    </span>
                  ) : null}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {isFiltering && !financeAnalysisIntent ? (
          <CommandGroup heading="Ask One">
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
        ) : null}

        {isFiltering && !financeAnalysisIntent ? <CommandSeparator /> : null}

        {isFiltering && !financeAnalysisIntent ? (
        <CommandGroup heading="Commands">
          {rankedActionMatches.length === 0 ? (
            <CommandItem className={commandItemClass} disabled>
              <Icon icon={Compass} size="sm" className="mr-2 text-muted-foreground" />
              No matching Kai actions.
            </CommandItem>
          ) : null}
          {rankedActionMatches.map(({ action, availability }) => {
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
        ) : null}

        {/* Ticker rows are Finance's, not every screen's. Searching on
            Location used to answer with SEC equities. Rendered conditionally
            rather than hidden, because cmdk owns group visibility once a
            query is typed and would happily bring it back. */}
        {isFiltering && (financeSectionActive || financeAnalysisIntent) ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Market results">
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
                  value={`${ANALYZE_PREFIX}${ticker} ${title} ${row.sector || row.sector_primary || ""} ${row.exchange || ""}`}
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
          </>
        ) : null}
      </CommandList>
      <div className="relative border-t border-border/70">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          onKeyDown={submitSearchOrPrompt}
          disabled={disabled}
          placeholder={financeAnalysisIntent ? "Analyze a stock" : "Ask One or search"}
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

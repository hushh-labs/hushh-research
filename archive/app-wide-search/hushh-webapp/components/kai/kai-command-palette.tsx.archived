"use client";

import { searchTargetMatchesCurrentRoute } from "@/lib/search/search-route-context";

import {
  Fragment,
  useMemo,
  useState,
  useEffect,
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
} from "@/components/icons";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import { mailDisplayLabel } from "@/lib/copy/mail-terminology";
import {
  getTickerUniverseSnapshot,
  preloadTickerUniverse,
  searchTickerUniverseRemote,
  searchTickerUniverse,
  type TickerUniverseRow,
} from "@/lib/kai/ticker-universe-cache";
import type { KaiActionDefinition } from "@/lib/kai/actions/kai-action-gateway";
import type { AppRuntimeState } from "@/lib/kai/actions/voice-types";
import type { VoiceCapabilityStateV1 } from "@/lib/kai/actions/capability-projection";
import type { VoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { navigationActionForRoute } from "@/lib/kai/actions/navigation-journey";
import { KAI_MARKET_PATH, ROUTES } from "@/lib/navigation/routes";
import type { KaiCommandBarIntent } from "@/lib/navigation/kai-command-bar-events";
import { Icon, type IconProps } from "@/lib/morphy-ux/ui";
import {
  findExactCatalogMatch,
  getCatalogEntry,
  getIdleSuggestions,
  searchCatalog,
  type SearchCatalogEntry,
  type SearchCatalogIconHint,
} from "@/lib/search/search-suggestions-catalog";

export type KaiCommandPaletteSelection = {
  actionId: string;
  slots?: Record<string, unknown>;
};

/** A holding the person can analyze. Eligibility is decided by the caller. */
export type KaiPortfolioTicker = {
  symbol: string;
  name?: string;
  sector?: string;
  asset_type?: string;
};

interface KaiCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectAction: (selection: KaiCommandPaletteSelection) => void;
  onSubmitPrompt: (prompt: string) => void;
  intent?: KaiCommandBarIntent;
  initialQuery?: string;
  appRuntimeState?: AppRuntimeState;
  surfaceMetadata?: VoiceSurfaceMetadata | null;
  capabilityState?: VoiceCapabilityStateV1;
  /** Scopes usage memory per account; a shared device must not blend habits. */
  userId?: string | null;
  portfolioTickers?: KaiPortfolioTicker[];
}

const ANALYZE_PREFIX = "Analyze ";

export function deriveFinanceTickerQuery(
  query: string,
  intent?: KaiCommandBarIntent,
): string {
  const trimmed = query.trim();
  if (intent !== "finance_stock_analysis") {
    return trimmed;
  }
  if (!trimmed.toLowerCase().startsWith("analyze")) return trimmed;
  return trimmed.slice("analyze".length).trim();
}

/**
 * Typing pauses this long before Finance's ticker search is asked.
 */
const TICKER_SEARCH_DELAY_MS = 160;
const TICKER_RESULT_LIMIT = 20;

/**
 * Control ids currently present and enabled in the document.
 *
 * Kept for `kai-command-palette-groups.test.ts`, which predates Search's
 * static catalog and still exercises this as a DOM read. The destination-only projection does not need mounted control identifiers.
 */
export function readTappableControlIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  if (typeof document === "undefined") return ids;
  document
    .querySelectorAll<HTMLElement>("[data-voice-control-id]")
    .forEach((element) => {
      const id = (element.dataset.voiceControlId || "").trim();
      if (!id) return;
      if (element.hasAttribute("disabled")) return;
      if (element.getAttribute("aria-disabled") === "true") return;
      ids.add(id);
    });
  return ids;
}

/**
 * The action that opens the screen `action` lives on, if one exists.
 *
 * Kept for `kai-command-palette-groups.test.ts`; The destination projection only
 * lists destinations that are already runnable from anywhere, so it has no
 * remaining caller for this.
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
 * Kept for `kai-command-palette-groups.test.ts`; see `navigationActionForAction`.
 */
export function isLocalHandlerAwayFromItsScreen(
  action: KaiActionDefinition,
  screen: string | null,
): boolean {
  const target = action.execution_target;
  if (target.status !== "wired" || target.path !== "local_handler")
    return false;
  const screens = action.reachability.screens;
  if (screens.length === 0) return false;
  return !screen || !screens.includes(screen);
}

/**
 * True when running `action` would land exactly where the person already is.
 *
 * Kept for `kai-command-palette-groups.test.ts`; see `navigationActionForAction`.
 */
export function actionTargetsCurrentSurface(
  action: KaiActionDefinition,
  pathname: string,
  subview: string | null,
  currentHref?: string,
): boolean {
  const target = action.execution_target;
  if (target.status !== "wired" || target.path !== "route") return false;
  if (currentHref) return searchTargetMatchesCurrentRoute(String(target.target || ""), currentHref);
  const [targetPath, targetQuery] = String(target.target || "").split("?");
  if (targetPath !== pathname) return false;
  if (!targetQuery) return !subview;
  const params = new URLSearchParams(targetQuery);
  const targetSubview =
    params.get("action") || params.get("view") || params.get("tab");
  return Boolean(targetSubview) && targetSubview === subview;
}

/**
 * Whether a tap in search can actually run `action`.
 *
 * Kept for `kai-command-palette-groups.test.ts`; The destination projection is
 * pre-filtered to destinations a tap can always run, so it has no remaining
 * caller for this.
 */
export function isOfferableInSearch(action: KaiActionDefinition): boolean {
  const target = action.execution_target;
  const isRoute = target.status === "wired" && target.path === "route";
  if (action.reachability.hidden_navigable && !isRoute) return false;
  const requiredInputs = action.goal?.required_inputs ?? [];
  return !requiredInputs.some(
    (input) =>
      input.required !== false &&
      String(input.resolver || "").startsWith("opaque_"),
  );
}

/** Finance owns ticker rows; searching on Location must not answer with equities. */
function isFinancePath(pathname: string): boolean {
  return (
    pathname === KAI_MARKET_PATH ||
    pathname.startsWith(`${KAI_MARKET_PATH}/`) ||
    pathname === ROUTES.LEGACY_KAI_HOME ||
    pathname.startsWith(`${ROUTES.LEGACY_KAI_HOME}/`)
  );
}

function isLikelySecCommonEquityRow(row: TickerUniverseRow): boolean {
  if (row.tradable === false) return false;
  const ticker = String(row.ticker || "")
    .trim()
    .toUpperCase();
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
      combined,
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

/** How well a row describes its ticker; picks between duplicates of one symbol. */
function rankTickerRow(row: TickerUniverseRow, qUpper: string): number {
  const prefixBoost = String(row.ticker || "")
    .toUpperCase()
    .startsWith(qUpper)
    ? 1000
    : 0;
  const confidence = Number(row.metadata_confidence || 0) * 100;
  const sectorBoost = isSpecificSectorLabel(row.sector || row.sector_primary)
    ? 20
    : 0;
  const exchangeBoost =
    toNonEmpty(row.exchange) &&
    String(row.exchange).toLowerCase() !== "portfolio"
      ? 5
      : 0;
  return prefixBoost + confidence + sectorBoost + exchangeBoost;
}

/** One tradable row per ticker, keeping the best-described duplicate. */
function dedupeTickerRows(
  rows: TickerUniverseRow[],
  qUpper: string,
): TickerUniverseRow[] {
  const byTicker = new Map<string, TickerUniverseRow>();
  for (const row of rows) {
    const ticker = String(row.ticker || "")
      .trim()
      .toUpperCase();
    if (!ticker || row.tradable === false) continue;
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
  return Array.from(byTicker.values());
}

/**
 * Typed: symbols that start with the query first. Untyped: the person's own
 * holdings first. Then metadata confidence, then alphabetical.
 */
function compareTickerRows(
  a: TickerUniverseRow,
  b: TickerUniverseRow,
  qUpper: string,
  portfolio: ReadonlySet<string>,
): number {
  if (qUpper) {
    const aPrefix = a.ticker.startsWith(qUpper) ? 1 : 0;
    const bPrefix = b.ticker.startsWith(qUpper) ? 1 : 0;
    if (aPrefix !== bPrefix) return bPrefix - aPrefix;
  } else {
    const aPortfolio = portfolio.has(a.ticker) ? 1 : 0;
    const bPortfolio = portfolio.has(b.ticker) ? 1 : 0;
    if (aPortfolio !== bPortfolio) return bPortfolio - aPortfolio;
  }
  const aScore = Number(a.metadata_confidence || 0);
  const bScore = Number(b.metadata_confidence || 0);
  if (aScore !== bScore) return bScore - aScore;
  return a.ticker.localeCompare(b.ticker);
}

type RowIcon = IconProps["icon"];

/** Maps a catalog entry's authored icon hint to the component it renders. */
const ICON_BY_HINT: Record<SearchCatalogIconHint, RowIcon> = {
  profile: UserRound,
  consent: ShieldCheck,
  history: History,
  market: TrendingUp,
  location: Compass,
  memory: Compass,
  wallet: Compass,
  feed: Compass,
  agents: Compass,
  generic: Activity,
};

/**
 * One result, rendered by both layouts: a cmdk item on desktop, a plain
 * button on phones. Building rows once is what keeps the two from drifting.
 */
type PaletteRow = {
  /** Unique across the palette: the React key and cmdk's selection value. */
  value: string;
  label: string;
  /** A ticker's company, or why a surface is suggesting this action. */
  detail?: string | null;
  icon: RowIcon;
  accent?: boolean;
  /** Ticker rows lead with the symbol in bold. */
  ticker?: boolean;
  disabled: boolean;
  run: () => void;
};

type PaletteSection = {
  heading: string;
  rows: PaletteRow[];
  /** Shown instead of rows when there are none, e.g. why the market is empty. */
  emptyNote?: string;
};

function PaletteRowContent({ row }: { row: PaletteRow }) {
  return (
    <>
      <Icon
        icon={row.icon}
        size="sm"
        className={row.accent ? "text-accent-strong" : "text-muted-foreground"}
      />
      {row.ticker ? (
        <>
          <span className="font-semibold">{row.label}</span>
          {row.detail ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {row.detail}
            </span>
          ) : null}
        </>
      ) : (
        <span className="flex min-w-0 flex-col">
          <span className="min-w-0 truncate font-medium">{row.label}</span>
          {row.detail ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {row.detail}
            </span>
          ) : null}
        </span>
      )}
    </>
  );
}

const fieldButtonClass =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground";

function SearchFieldButtons({
  showClear,
  clearTestId,
  onClear,
  onClose,
}: {
  showClear: boolean;
  clearTestId: string;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <>
      {showClear ? (
        <button
          type="button"
          aria-label="Clear search input"
          data-testid={clearTestId}
          onClick={onClear}
          className={fieldButtonClass}
        >
          <X className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Close search"
        onClick={onClose}
        className={fieldButtonClass}
      >
        <X className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
      </button>
    </>
  );
}

const commandItemClass =
  "gap-4 rounded-lg border border-transparent transition-[background-color,border-color,color,transform] duration-100 ease-out hover:bg-primary/10 hover:text-foreground data-[selected=true]:border-primary/25 data-[selected=true]:bg-primary/15 data-[selected=true]:text-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45";

const mobileResultRowClass =
  "flex min-h-11 w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left text-[15px] text-foreground transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:opacity-45";

const noteClass = "px-3 py-6 text-center text-sm text-muted-foreground";

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
  portfolioTickers = [],
}: KaiCommandPaletteProps) {
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  // cmdk's highlighted row. Tracked so Enter can tell "the top row, untouched"
  // apart from a row the person arrowed to.
  const [highlighted, setHighlighted] = useState("");
  const trimmedQuery = query.trim();
  const isFiltering = trimmedQuery.length > 0;

  // `route.pathname` carries the query string as well -- the runtime state
  // builder feeds it `pathnameWithQuery` -- so the path has to be split back
  // out before it can be compared with Finance's market paths.
  const currentPath =
    String(appRuntimeState?.route.pathname || "")
      .trim()
      .split("?")[0] || "";

  // The authored Analysis action is the sole authority for this workflow.
  // Global query text must not act as a parallel semantic router.
  const financeAnalysisIntent = intent === "finance_stock_analysis";
  const showMarket = financeAnalysisIntent || isFinancePath(currentPath);
  const tickerQuery = deriveFinanceTickerQuery(query, intent);

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery ?? (financeAnalysisIntent ? ANALYZE_PREFIX : ""));
    // A highlight left over from the last opening would stop cmdk from
    // highlighting the top row of this one.
    setHighlighted("");
  }, [financeAnalysisIntent, initialQuery, open]);

  // The ticker universe is Finance's data. Opening search anywhere else must
  // not pay for an equities index it would never show.
  const [universe, setUniverse] = useState<TickerUniverseRow[] | null>(
    getTickerUniverseSnapshot,
  );
  const [loadingUniverse, setLoadingUniverse] = useState(false);
  const [universeFailed, setUniverseFailed] = useState(false);
  useEffect(() => {
    if (!open || !showMarket) return;
    let cancelled = false;
    setLoadingUniverse(true);
    setUniverseFailed(false);
    preloadTickerUniverse()
      .then((rows) => {
        if (!cancelled) setUniverse(rows);
      })
      .catch(() => {
        if (cancelled) return;
        setUniverse((prev) => prev ?? []);
        setUniverseFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingUniverse(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, showMarket]);

  const [remoteTickers, setRemoteTickers] = useState<{
    query: string;
    rows: TickerUniverseRow[];
    failed: boolean;
  }>({ query: "", rows: [], failed: false });
  useEffect(() => {
    if (!open || !showMarket || tickerQuery.length < 2) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchTickerUniverseRemote(tickerQuery, TICKER_RESULT_LIMIT)
        .then((rows) => {
          if (!cancelled) {
            setRemoteTickers({ query: tickerQuery, rows, failed: false });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setRemoteTickers({ query: tickerQuery, rows: [], failed: true });
          }
        });
    }, TICKER_SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, showMarket, tickerQuery]);
  const remote = remoteTickers.query === tickerQuery ? remoteTickers : null;

  const portfolioRows = useMemo<TickerUniverseRow[]>(() => {
    const enrichment = new Map<string, TickerUniverseRow>();
    for (const row of universe ?? []) {
      const ticker = String(row.ticker || "")
        .trim()
        .toUpperCase();
      if (ticker) enrichment.set(ticker, row);
    }
    const deduped = new Map<string, TickerUniverseRow>();
    for (const row of portfolioTickers) {
      const symbol = String(row.symbol || "")
        .trim()
        .toUpperCase();
      if (!symbol || deduped.has(symbol)) continue;
      const enriched = enrichment.get(symbol);
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
        industry_primary: toNonEmpty(
          enriched?.industry || enriched?.industry_primary,
        ),
        exchange: toNonEmpty(enriched?.exchange) || "Portfolio",
        metadata_confidence:
          typeof enriched?.metadata_confidence === "number"
            ? enriched.metadata_confidence
            : 1,
        tradable: true,
      });
    }
    return Array.from(deduped.values());
  }, [portfolioTickers, universe]);

  const tickerMatches = useMemo(() => {
    if (!showMarket) return [];
    const rows = universe ?? [];
    const qUpper = tickerQuery.toUpperCase();
    let candidates: TickerUniverseRow[];
    if (!tickerQuery) {
      candidates = [
        ...portfolioRows,
        ...rows.filter(isLikelySecCommonEquityRow),
      ];
    } else {
      const qLower = tickerQuery.toLowerCase();
      candidates = [
        ...portfolioRows.filter(
          (row) =>
            row.ticker.includes(qUpper) ||
            String(row.title || "")
              .toLowerCase()
              .includes(qLower),
        ),
        ...searchTickerUniverse(rows, tickerQuery, TICKER_RESULT_LIMIT).filter(
          isLikelySecCommonEquityRow,
        ),
        ...(remote?.rows ?? []).filter(isLikelySecCommonEquityRow),
      ];
    }
    const portfolio = new Set(portfolioRows.map((row) => row.ticker));
    return dedupeTickerRows(candidates, qUpper)
      .sort((a, b) => compareTickerRows(a, b, qUpper, portfolio))
      .slice(0, TICKER_RESULT_LIMIT);
  }, [portfolioRows, remote, showMarket, tickerQuery, universe]);

  const suggestionContext = useMemo(() => ({appRuntimeState, capabilityState, surfaceMetadata}),
    [appRuntimeState, capabilityState, surfaceMetadata]);
  const actionMatches = useMemo<SearchCatalogEntry[]>(() => {
    if (!isFiltering || financeAnalysisIntent) return [];
    return searchCatalog(trimmedQuery, 24, suggestionContext);
  }, [financeAnalysisIntent, isFiltering, trimmedQuery, suggestionContext]);

  const exactActionMatch = useMemo<SearchCatalogEntry | null>(() => {
    if (!trimmedQuery) return null;
    return findExactCatalogMatch(trimmedQuery, suggestionContext) ?? null;
  }, [trimmedQuery, suggestionContext]);

  // Curated order remains stable; current generated authority gates every row.
  const curatedSuggestions = useMemo(() => {
    if (isFiltering) return [];
    const suggestions: Array<{ entry: SearchCatalogEntry; note: string | null }> = [];
    const seen = new Set<string>();
    const deadEnd = surfaceMetadata?.deadEnd;
    const remedy = deadEnd?.remedyActionId
      ? getCatalogEntry(deadEnd.remedyActionId, suggestionContext) : undefined;
    if (remedy && deadEnd?.reason) {
      suggestions.push({entry: remedy, note: deadEnd.reason});
      seen.add(remedy.actionId);
    }
    for (const entry of getIdleSuggestions(suggestionContext)) {
      if (seen.has(entry.actionId)) continue;
      seen.add(entry.actionId);
      suggestions.push({entry, note: null});
    }
    return suggestions;
  }, [isFiltering, surfaceMetadata, suggestionContext]);

  function close() {
    onOpenChange(false);
    setQuery("");
  }

  function runAction(actionId: string, slots?: Record<string, unknown>) {
    close();
    onSelectAction({ actionId, slots });
  }

  function askOne() {
    if (!isFiltering) return;
    close();
    onSubmitPrompt(trimmedQuery);
  }

  /**
   * Enter with the top row untouched: an exact action name runs that action,
   * a lone ticker is analyzed, and anything else goes to One as a question.
   */
  function submitQuery() {
    if (!isFiltering) return;
    if (financeAnalysisIntent) {
      const soleMatch = tickerMatches.length === 1 ? tickerMatches[0] : null;
      if (soleMatch) {
        runAction("analysis.start", { symbol: soleMatch.ticker });
      }
      return;
    }
    if (exactActionMatch) {
      runAction(exactActionMatch.actionId);
      return;
    }
    askOne();
  }

  const catalogActionRow = (
    entry: SearchCatalogEntry,
    note: string | null = null,
  ): PaletteRow => ({
    value: `action:${entry.actionId}`,
    label: mailDisplayLabel(entry.label),
    detail: entry.disabled ? entry.reason : note,
    icon: note ? Lightbulb : (ICON_BY_HINT[entry.icon] ?? Activity),
    accent: Boolean(note),
    disabled: entry.disabled,
    run: () => { if (!entry.disabled) runAction(entry.actionId); },
  });

  const sections: PaletteSection[] = [];
  if (!isFiltering) {
    sections.push({
      heading: "Suggested",
      rows: curatedSuggestions.map(({ entry, note }) =>
        catalogActionRow(entry, note),
      ),
    });
  } else {
    if (!financeAnalysisIntent) {
      sections.push({
        heading: "Ask One",
        rows: [
          {
            value: "ask-one",
            label: `Ask One: ${trimmedQuery}`,
            icon: Search,
            accent: true,
            disabled: false,
            run: askOne,
          },
        ],
      });
      sections.push({
        heading: "Commands",
        rows: actionMatches.map((entry) => catalogActionRow(entry)),
      });
    }
    if (showMarket) {
      sections.push({
        heading: "Market results",
        rows: tickerMatches.map((row) => {
          const sector = row.sector || row.sector_primary;
          return {
            value: `ticker:${row.ticker}`,
            label: row.ticker,
            detail: [row.title || "Unknown company", sector]
              .filter(Boolean)
              .join(" • "),
            icon: TrendingUp,
            ticker: true,
            disabled: false,
            run: () => runAction("analysis.start", { symbol: row.ticker }),
          };
        }),
        emptyNote: loadingUniverse
          ? "Loading…"
          : universeFailed
            ? "Tickers unavailable."
            : remote?.failed
              ? "Ticker search failed."
              : "No matching tickers.",
      });
    }
  }
  const visibleSections = sections.filter(
    (section) => section.rows.length > 0 || section.emptyNote,
  );
  const topRowValue = visibleSections
    .flatMap((section) => section.rows)
    .find((row) => !row.disabled)?.value;

  const placeholder = financeAnalysisIntent
    ? "Analyze a stock"
    : "Ask One or search";

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    // With nothing typed, or with the highlight moved off the top row, Enter
    // runs the highlighted row -- cmdk's job. Taking every Enter here is what
    // once made arrow-key selection unreachable.
    if (!isFiltering || (highlighted && highlighted !== topRowValue)) return;
    event.preventDefault();
    submitQuery();
  }

  if (isMobile) {
    // On phones search is an input surface, not a command palette: the same
    // rows as plain buttons, so the keyboard can sit above a native-looking
    // bottom search field.
    return (
      <Dialog open={open} onOpenChange={onOpenChange} modal>
        <DialogContent
          showCloseButton={false}
          srDescription="Search or ask One"
          data-keyboard-anchor="bottom"
          data-search-surface="ios-mobile"
          className="!top-auto !bottom-[calc(var(--kb-height,0px)+var(--palette-chrome-clearance,var(--bottom-chrome-stack-height,0px))+0.5rem)] !left-2 !w-[calc(100%-1rem)] !max-w-none !translate-x-0 !translate-y-0 !overflow-hidden !rounded-[26px] !border-black/[0.08] !bg-background/96 !p-2 !shadow-[0_18px_52px_-28px_rgba(0,0,0,.52)]"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Search or ask One</DialogTitle>
          </DialogHeader>
          <div
            className="max-h-[min(52dvh,25rem)] overflow-y-auto overscroll-contain px-1 py-1"
            data-testid="kai-mobile-search-results"
          >
            {visibleSections.length === 0 ? (
              <p className={noteClass}>No suggestions yet.</p>
            ) : null}
            {visibleSections.map((section) => (
              <Fragment key={section.heading}>
                {section.rows.map((row) => (
                  <button
                    type="button"
                    key={row.value}
                    className={mobileResultRowClass}
                    onClick={row.run}
                    disabled={row.disabled}
                  >
                    <PaletteRowContent row={row} />
                  </button>
                ))}
                {section.rows.length === 0 && section.emptyNote ? (
                  <p className={noteClass}>{section.emptyNote}</p>
                ) : null}
              </Fragment>
            ))}
          </div>
          <form
            className="relative flex h-12 items-center gap-2 rounded-[20px] bg-foreground/[0.045] px-3"
            onSubmit={(event) => {
              event.preventDefault();
              submitQuery();
            }}
          >
            <Search
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              type="search"
              autoFocus
              enterKeyHint="send"
              placeholder={placeholder}
              aria-label="Search or ask One"
              className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-muted-foreground"
            />
            <SearchFieldButtons
              showClear={query.length > 0}
              clearTestId="kai-mobile-search-clear"
              onClear={() => setQuery("")}
              onClose={() => onOpenChange(false)}
            />
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      showCloseButton={false}
      title="Search or ask One"
      // The palette ranks its own results. cmdk's fuzzy filter would re-rank
      // them, and drop related-by-meaning matches that share no letters with
      // the query.
      commandProps={{
        shouldFilter: false,
        value: highlighted,
        onValueChange: setHighlighted,
      }}
    >
      <CommandList>
        <CommandEmpty>No suggestions yet.</CommandEmpty>
        {visibleSections.map((section) => (
          <CommandGroup key={section.heading} heading={section.heading}>
            {section.rows.map((row) => (
              <CommandItem
                className={commandItemClass}
                key={row.value}
                value={row.value}
                disabled={row.disabled}
                onSelect={row.run}
              >
                <PaletteRowContent row={row} />
              </CommandItem>
            ))}
            {section.rows.length === 0 && section.emptyNote ? (
              <CommandItem
                className={commandItemClass}
                value={`note:${section.heading}`}
                disabled
              >
                {section.emptyNote}
              </CommandItem>
            ) : null}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="relative border-t border-border/70">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          onKeyDown={onInputKeyDown}
          placeholder={placeholder}
          className="pr-28"
          enterKeyHint="send"
          autoFocus
        />
        <div className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          <SearchFieldButtons
            showClear={query.length > 0}
            clearTestId="kai-search-clear"
            onClear={() => setQuery("")}
            onClose={() => onOpenChange(false)}
          />
        </div>
      </div>
    </CommandDialog>
  );
}

"use client";

import {
  Fragment,
  useCallback,
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
import {
  evaluateKaiActionAvailability,
  getKaiActionById,
  listKaiActionsForSurface,
  searchKaiActions,
  searchKaiActionsSemantic,
  type KaiActionAvailability,
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
import { Icon, type IconProps } from "@/lib/morphy-ux/ui";
import { useVault } from "@/lib/vault/vault-context";
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
  capabilityState?: VoiceCapabilityStateV1;
  surfaceMetadata?: VoiceSurfaceMetadata | null;
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
 * How many rows each unfiltered group offers. Location alone declares
 * nineteen actions; listing every one would bury the other group entirely.
 * The list scrolls, so this is about what reads at a glance rather than about
 * what is reachable -- anything cut here is still one typed word away.
 */
const GROUP_LIMIT = 6;

/**
 * Typing pauses this long before a backend is asked. Local results render on
 * every keystroke; these only add to them.
 */
const SEMANTIC_SEARCH_DELAY_MS = 180;
const TICKER_SEARCH_DELAY_MS = 160;
const TICKER_RESULT_LIMIT = 20;

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
  if (target.status !== "wired" || target.path !== "local_handler")
    return false;
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

/**
 * Whether a tap in search can actually run `action`.
 *
 * The catalog also holds entries that exist only for One itself: hand-offs to
 * a specialist agent ("Ask Consent (Nav)"), widgets that live inside chat
 * ("Reveal a card"), and actions that need an id only an earlier tool call
 * produces ("Request someone's information" needs a proposal id). Tapped from
 * search these do nothing, so offering them made search look broken.
 *
 * `hidden_navigable` alone is not the test: plenty of hidden entries are real
 * destinations ("Show Holdings"), and a route runs from anywhere.
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

/** Whether choosing an action with this availability does anything. */
function isRunnable(availability: KaiActionAvailability): boolean {
  return (
    availability.status !== "dead" &&
    availability.status !== "unwired" &&
    availability.status !== "manual_only" &&
    availability.status !== "blocked"
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

/** A few destinations have a recognisable icon; every other command shares one. */
const COMMAND_ICONS: Partial<Record<string, RowIcon>> = {
  "route.profile": UserRound,
  "route.consents": ShieldCheck,
  "route.analysis_history": History,
  "route.kai_home": Compass,
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
  "gap-4 rounded-lg border border-transparent transition-[background-color,border-color,color,transform] duration-100 ease-out active:scale-[0.98] hover:bg-primary/10 hover:text-foreground data-[selected=true]:border-primary/25 data-[selected=true]:bg-primary/15 data-[selected=true]:text-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45";

const mobileResultRowClass =
  "flex min-h-11 w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left text-[15px] text-foreground transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] active:scale-[0.99] disabled:opacity-45";

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
  userId = null,
  portfolioTickers = [],
}: KaiCommandPaletteProps) {
  // The semantic action search is a VAULT_OWNER-authenticated endpoint; the
  // palette is rendered inside VaultProvider, so the token is available here
  // without threading it through every caller as a prop.
  const { vaultOwnerToken } = useVault();
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  // cmdk's highlighted row. Tracked so Enter can tell "the top row, untouched"
  // apart from a row the person arrowed to.
  const [highlighted, setHighlighted] = useState("");
  const trimmedQuery = query.trim();
  const isFiltering = trimmedQuery.length > 0;

  const currentScreen =
    String(appRuntimeState?.route.screen || "").trim() || null;
  // `route.pathname` carries the query string as well -- the runtime state
  // builder feeds it `pathnameWithQuery` -- so the path has to be split back
  // out before it can be compared with a contract's route target.
  const currentPath =
    String(appRuntimeState?.route.pathname || "")
      .trim()
      .split("?")[0] || "";
  const currentSubview =
    String(appRuntimeState?.route.subview || "").trim() || null;

  // The authored Analysis action is the sole authority for this workflow.
  // Global query text must not act as a parallel semantic router.
  const financeAnalysisIntent = intent === "finance_stock_analysis";
  const showMarket = financeAnalysisIntent || isFinancePath(currentPath);
  const tickerQuery = deriveFinanceTickerQuery(query, intent);

  const isDiscoverable = useCallback(
    (actionId: string) =>
      !capabilityState ||
      isDiscoverableCapability(
        projectKaiActionCapability({
          actionId,
          state: capabilityState,
          surfaceMetadata,
        }),
      ),
    [capabilityState, surfaceMetadata],
  );

  /**
   * Captured when the palette opens, because they describe the page underneath
   * and that page can change between openings. A dialog leaves the rest of the
   * document mounted, so the control query still sees it.
   */
  const [tappableControlIds, setTappableControlIds] = useState<
    ReadonlySet<string>
  >(() => new Set<string>());
  const [usage, setUsage] = useState<readonly ActionUsageEntry[]>([]);
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery ?? (financeAnalysisIntent ? ANALYZE_PREFIX : ""));
    // A highlight left over from the last opening would stop cmdk from
    // highlighting the top row of this one.
    setHighlighted("");
    setTappableControlIds(readTappableControlIds());
    setUsage(readActionUsage(userId));
  }, [financeAnalysisIntent, initialQuery, open, userId]);

  // Results are tagged with the query they answer, so a slow response for an
  // earlier query can never be shown against the current one.
  const [semantic, setSemantic] = useState<{
    query: string;
    results: Awaited<ReturnType<typeof searchKaiActionsSemantic>>;
  }>({ query: "", results: [] });
  useEffect(() => {
    if (!open || !trimmedQuery || financeAnalysisIntent) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchKaiActionsSemantic({
        query: trimmedQuery,
        appRuntimeState,
        surfaceMetadata,
        limit: 10,
        signal: controller.signal,
        // A locked vault means no token, and the search stays local.
        vaultOwnerToken,
      }).then((results) => {
        if (!controller.signal.aborted) {
          setSemantic({ query: trimmedQuery, results });
        }
      });
    }, SEMANTIC_SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // vaultOwnerToken is a real dependency, not decoration: unlocking the vault
    // must re-run the search or the palette stays lexical for the session.
  }, [
    appRuntimeState,
    financeAnalysisIntent,
    open,
    surfaceMetadata,
    trimmedQuery,
    vaultOwnerToken,
  ]);

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

  /**
   * Actions matching what was typed.
   *
   * Wording matches come first, ranked by the gateway with this person's
   * habits folded into the score -- enough to separate near-equal matches,
   * never enough to outrank a better one: typing "circle" must find Create a
   * circle whether or not you have ever created one. Related-by-meaning
   * results from the backend follow them. They arrive later, so they add rows
   * instead of reordering what is already on screen.
   */
  const actionMatches = useMemo(() => {
    if (!isFiltering || financeAnalysisIntent) return [];
    const local = searchKaiActions({
      query: trimmedQuery,
      appRuntimeState,
      surfaceMetadata,
      limit: 24,
      boost: (actionId) => usageBoostFor(usage, actionId),
    });
    const localIds = new Set(local.map(({ action }) => action.action_id));
    const related =
      semantic.query === trimmedQuery ? semantic.results : [];
    return [
      ...local,
      ...related.filter(({ action }) => !localIds.has(action.action_id)),
    ].filter(({ action }) => {
      if (!isOfferableInSearch(action)) return false;
      if (
        isLocalHandlerAwayFromItsScreen(action, currentScreen) &&
        !navigationActionForAction(action)
      ) {
        return false;
      }
      return isDiscoverable(action.action_id);
    });
  }, [
    appRuntimeState,
    currentScreen,
    financeAnalysisIntent,
    isDiscoverable,
    isFiltering,
    semantic,
    surfaceMetadata,
    trimmedQuery,
    usage,
  ]);

  const exactActionMatch = useMemo(() => {
    const normalized = trimmedQuery.toLowerCase();
    if (!normalized) return null;
    return (
      actionMatches.find(
        ({ action, availability }) =>
          isRunnable(availability) &&
          [
            action.action_id,
            action.label,
            mailDisplayLabel(action.label),
            ...action.aliases,
          ].some((value) => value.trim().toLowerCase() === normalized),
      ) ?? null
    );
  }, [actionMatches, trimmedQuery]);

  /**
   * What the screen the person is looking at can actually do, read straight
   * from the action gateway -- so a surface that authors a new action in its
   * voice contract shows up here with no change to this file.
   *
   * Unlike typed results, which show a blocked action together with the reason
   * it is blocked, these are a menu of what is possible right now: an entry
   * that cannot run does not belong.
   */
  const surfaceActions = useMemo(() => {
    if (isFiltering || (!currentScreen && !currentPath)) return [];
    return listKaiActionsForSurface({
      screen: currentScreen,
      pathname: currentPath,
    })
      .filter(
        (action) =>
          isOfferableInSearch(action) &&
          !actionTargetsCurrentSurface(action, currentPath, currentSubview),
      )
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
      .filter(
        ({ action, availability }) =>
          availability.status === "available" &&
          isDiscoverable(action.action_id),
      );
  }, [
    appRuntimeState,
    currentPath,
    currentScreen,
    currentSubview,
    isDiscoverable,
    isFiltering,
    surfaceMetadata,
    tappableControlIds,
  ]);

  /**
   * What this person reaches for, offered before anything the app guessed.
   *
   * Held to the same availability and capability rules as every other group --
   * a habit is not a reason to offer something that cannot run -- and minus
   * whatever is already a button in front of them.
   */
  const recentActions = useMemo(() => {
    if (isFiltering) return [];
    const rows: Array<{
      action: KaiActionDefinition;
      availability: KaiActionAvailability;
    }> = [];
    for (const entry of usage) {
      if (rows.length >= RECENT_ACTION_LIMIT) break;
      const action = getKaiActionById(entry.actionId);
      // Usage recorded before search stopped offering agent-only actions
      // would otherwise keep bringing them back as habits.
      if (!action || !isOfferableInSearch(action)) continue;
      if (action.control_ids.some((id) => tappableControlIds.has(id))) continue;
      if (isLocalHandlerAwayFromItsScreen(action, currentScreen)) continue;
      const availability = evaluateKaiActionAvailability({
        action,
        appRuntimeState,
        surfaceMetadata,
      });
      if (availability.status !== "available") continue;
      if (!isDiscoverable(action.action_id)) continue;
      rows.push({ action, availability });
    }
    return rows;
  }, [
    appRuntimeState,
    currentScreen,
    isDiscoverable,
    isFiltering,
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
   * anything with authored guidance, then the section's own basics -- which
   * are exactly the controls visible on this screen.
   */
  const suggestedActions = useMemo(() => {
    if (isFiltering) return [];
    const suggestions: Array<{
      action: KaiActionDefinition;
      availability: KaiActionAvailability;
      note: string | null;
    }> = [];
    const seen = new Set<string>();
    const push = (
      action: KaiActionDefinition,
      availability: KaiActionAvailability,
      note: string | null,
    ) => {
      if (seen.has(action.action_id)) return;
      seen.add(action.action_id);
      suggestions.push({ action, availability, note });
    };

    const deadEnd = surfaceMetadata?.deadEnd;
    const remedy = deadEnd?.remedyActionId
      ? getKaiActionById(deadEnd.remedyActionId)
      : null;
    if (remedy && deadEnd?.reason && isOfferableInSearch(remedy)) {
      push(
        remedy,
        evaluateKaiActionAvailability({
          action: remedy,
          appRuntimeState,
          surfaceMetadata,
        }),
        deadEnd.reason,
      );
    }
    surfaceActions.forEach(({ action, availability }) => {
      if (availability.blocked_guidance) {
        push(action, availability, availability.blocked_guidance);
      }
    });
    surfaceActions.forEach(({ action, availability, tappable }) => {
      if (tappable) push(action, availability, null);
    });
    return suggestions.slice(0, GROUP_LIMIT);
  }, [appRuntimeState, isFiltering, surfaceActions, surfaceMetadata]);

  function close() {
    onOpenChange(false);
    setQuery("");
  }

  function runAction(actionId: string, slots?: Record<string, unknown>) {
    // The id only, and only what the person actually chose -- not what was
    // merely offered, and never the slots that would turn a habit into a
    // holding.
    recordActionUse(userId, actionId);
    close();
    // A local handler belonging to another screen cannot run from here: the
    // runtime finds nothing mounted and reports `blocked`. Search covers the
    // whole app, so the honest answer is to take the person to the screen that
    // owns it rather than to hide the row or fail silently.
    const action = getKaiActionById(actionId);
    const navigationActionId =
      action && isLocalHandlerAwayFromItsScreen(action, currentScreen)
        ? navigationActionForAction(action)
        : null;
    onSelectAction(
      navigationActionId ? { actionId: navigationActionId } : { actionId, slots },
    );
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
      runAction(exactActionMatch.action.action_id);
      return;
    }
    askOne();
  }

  const actionRow = (
    action: KaiActionDefinition,
    availability: KaiActionAvailability,
    icon: RowIcon,
    note: string | null = null,
  ): PaletteRow => ({
    value: `action:${action.action_id}`,
    label: mailDisplayLabel(action.label),
    detail: note,
    icon,
    accent: Boolean(note),
    disabled: !isRunnable(availability),
    run: () => runAction(action.action_id),
  });

  const sections: PaletteSection[] = [];
  if (!isFiltering) {
    // One row per action across the unfiltered groups: a recent action can
    // also be off-screen here, and cmdk needs every value to be unique.
    const shown = new Set<string>();
    const firstTime = ({ action }: { action: KaiActionDefinition }) => {
      if (shown.has(action.action_id)) return false;
      shown.add(action.action_id);
      return true;
    };
    sections.push({
      heading: "You usually",
      rows: recentActions
        .filter(firstTime)
        .map(({ action, availability }) =>
          actionRow(action, availability, History),
        ),
    });
    sections.push({
      heading: "Elsewhere on this screen",
      rows: surfaceActions
        .filter(({ tappable }) => !tappable)
        .slice(0, GROUP_LIMIT)
        .filter(firstTime)
        .map(({ action, availability }) =>
          actionRow(action, availability, Compass),
        ),
    });
    sections.push({
      heading: "Suggested actions",
      rows: suggestedActions
        .filter(firstTime)
        .map(({ action, availability, note }) =>
          actionRow(action, availability, note ? Lightbulb : Compass, note),
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
        rows: actionMatches.map(({ action, availability }) =>
          actionRow(
            action,
            availability,
            COMMAND_ICONS[action.action_id] ?? Activity,
          ),
        ),
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

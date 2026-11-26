"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import {
  fetchRecentMail,
  MAIL_OVERVIEW_INITIAL_ROWS,
  MAIL_OVERVIEW_ROW_CAP,
  MailOverviewError,
  openMailMessage,
  prepareMailReply,
  searchMail,
  type MailOverviewPage,
  type MailOverviewReason,
  type MailOverviewRow,
  type MailReplySource,
  type OpenedOverviewMessage,
} from "@/lib/mail/mail-overview-client";
import { CacheService } from "@/lib/services/cache-service";
import {
  snapshotVaultSessionEpoch,
  subscribeVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

const CACHE_PREFIX = "mail_overview_";
const CACHE_TTL_MS = 10 * 60_000;
/** Where the person was (a submitted search, an open email); memory only. */
const UI_TTL_MS = 30 * 60_000;
/** A returning tab revalidates after this long, so the list is never silently old. */
const REVALIDATE_AFTER_MS = 60_000;

// Credential changes purge protected display information synchronously. The
// list lives in memory only, never in device storage.
subscribeVaultSessionEpoch(() =>
  CacheService.getInstance().invalidatePattern(CACHE_PREFIX),
);

/** Forgets every remembered row, search and open email for one owner. */
export function clearMailOverviewMemory(userId: string): void {
  CacheService.getInstance().invalidatePattern(`${CACHE_PREFIX}${userId}_`);
}

/**
 * Failures that mean this account's mail cannot be shown right now. Their rows
 * are dropped: an expired grant, a different account or a withdrawn read must
 * not leave the old mail on screen. An ordinary refresh failure keeps them.
 */
const ACCESS_LOSS: ReadonlySet<MailOverviewReason> = new Set([
  "auth_missing",
  "connect_required",
  "reconnect_required",
  "account_changed",
  "unavailable",
  "private_runtime",
]);

type Section = {
  page: MailOverviewPage | null;
  loading: boolean;
  /** A page is on screen and a newer one is being read. */
  refreshing: boolean;
  error: MailOverviewError | null;
  fetchedAt: number;
};

export type MailOpenedState = {
  sourceId: string;
  status: "loading" | "ready" | "error";
  message: OpenedOverviewMessage | null;
  error: MailOverviewError | null;
};

type State = {
  scopeKey: string;
  recent: Section & { expanded: boolean };
  search: (Section & { query: string }) | null;
  opened: MailOpenedState | null;
};

type Action =
  | { type: "reset"; state: State }
  | { type: "recent_start"; expanded?: boolean }
  /** `fetchedAt` is when the read finished, taken once: the screen and the cache agree. */
  | { type: "recent_done"; page: MailOverviewPage; fetchedAt: number }
  | { type: "recent_failed"; error: MailOverviewError }
  | { type: "search_start"; query: string }
  | { type: "search_done"; page: MailOverviewPage }
  | { type: "search_failed"; error: MailOverviewError }
  | { type: "search_clear" }
  | { type: "open_start"; sourceId: string }
  | { type: "open_done"; message: OpenedOverviewMessage }
  | { type: "open_failed"; error: MailOverviewError }
  | { type: "open_close" };

const EMPTY_SECTION: Section = {
  page: null,
  loading: false,
  refreshing: false,
  error: null,
  fetchedAt: 0,
};

function freshState(scopeKey: string, cached: CachedRecent | null): State {
  return {
    scopeKey,
    recent: {
      ...EMPTY_SECTION,
      page: cached?.page ?? null,
      fetchedAt: cached?.fetchedAt ?? 0,
      expanded: cached?.expanded ?? false,
    },
    search: null,
    opened: null,
  };
}

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return action.state;
    case "recent_start":
      return {
        ...state,
        recent: {
          ...state.recent,
          expanded: action.expanded ?? state.recent.expanded,
          loading: !state.recent.page,
          refreshing: Boolean(state.recent.page),
          error: null,
        },
      };
    case "recent_done":
      return {
        ...state,
        recent: {
          ...state.recent,
          page: action.page,
          loading: false,
          refreshing: false,
          error: null,
          // Only a read that succeeded for this account moves it. A failed or
          // superseded read leaves the time of the rows still on screen.
          fetchedAt: action.fetchedAt,
        },
      };
    case "recent_failed":
      return {
        ...state,
        recent: {
          ...state.recent,
          // Same account, ordinary failure: keep what was shown and say so.
          page: ACCESS_LOSS.has(action.error.reason) ? null : state.recent.page,
          loading: false,
          refreshing: false,
          error: action.error,
        },
        // Access is gone for everything, including a search and an open message.
        search: ACCESS_LOSS.has(action.error.reason) ? null : state.search,
        opened: ACCESS_LOSS.has(action.error.reason) ? null : state.opened,
      };
    case "search_start":
      return {
        ...state,
        search: { ...EMPTY_SECTION, query: action.query, loading: true },
        opened: null,
      };
    case "search_done":
      return state.search
        ? {
            ...state,
            search: {
              ...state.search,
              page: action.page,
              loading: false,
              error: null,
              fetchedAt: Date.now(),
            },
          }
        : state;
    case "search_failed":
      return state.search
        ? {
            ...state,
            search: {
              ...state.search,
              // A different query's rows are never shown under this one.
              page: null,
              loading: false,
              error: action.error,
            },
          }
        : state;
    case "search_clear":
      return { ...state, search: null, opened: null };
    case "open_start":
      return {
        ...state,
        opened: {
          sourceId: action.sourceId,
          status: "loading",
          message: null,
          error: null,
        },
      };
    case "open_done":
      return state.opened
        ? {
            ...state,
            opened: { ...state.opened, status: "ready", message: action.message },
          }
        : state;
    case "open_failed":
      return state.opened
        ? {
            ...state,
            opened: { ...state.opened, status: "error", error: action.error },
          }
        : state;
    case "open_close":
      return { ...state, opened: null };
  }
}

type CachedRecent = { page: MailOverviewPage; expanded: boolean; fetchedAt: number };
type CachedPlace = { query: string | null; openedSourceId: string | null };

function asError(error: unknown): MailOverviewError {
  return error instanceof MailOverviewError
    ? error
    : new MailOverviewError("unknown", { cause: error });
}

export type UseMailOverviewInput = {
  userId: string | null;
  /** Scopes cached rows. The account's Google subject, or its address when there is none. */
  accountKey: string | null;
  /** The Google subject the server must answer from, when the status reports one. */
  expectedAccount: string | null;
  vaultOwnerToken: string | null;
  connected: boolean;
  /** Only the visible Overview reads mail; a retained inactive pane never does. */
  active: boolean;
};

export function useMailOverview({
  userId,
  accountKey,
  expectedAccount,
  vaultOwnerToken,
  connected,
  active,
}: UseMailOverviewInput) {
  const epoch = snapshotVaultSessionEpoch();
  const ready = Boolean(connected && userId && accountKey && vaultOwnerToken);
  const scopeKey = `${userId ?? ""}\u0000${accountKey ?? ""}\u0000${epoch}\u0000${Boolean(vaultOwnerToken)}`;
  const cacheKey = `${CACHE_PREFIX}${userId ?? "guest"}_${accountKey ?? "none"}_${epoch}`;

  const cached = useCallback(
    () => CacheService.getInstance().peek<CachedRecent>(cacheKey)?.data ?? null,
    [cacheKey],
  );
  const [stored, dispatch] = useReducer(reduce, undefined, () =>
    freshState(scopeKey, ready ? cached() : null),
  );
  // A scope switch must not render the previous account's rows for even one frame.
  const state = useMemo(
    () => (stored.scopeKey === scopeKey ? stored : freshState(scopeKey, ready ? cached() : null)),
    [stored, scopeKey, ready, cached],
  );

  // Everything an in-flight request needs to know whether it is still wanted.
  const live = useRef({ scopeKey, token: vaultOwnerToken, expectedAccount });
  live.current = { scopeKey, token: vaultOwnerToken, expectedAccount };
  const generation = useRef(0);
  const tickets = useRef({ recent: 0, search: 0, open: 0 });
  const controllers = useRef<Record<"recent" | "search" | "open", AbortController | null>>({
    recent: null,
    search: null,
    open: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  // The restore effect runs before the callbacks below exist; it reaches them by ref.
  const submitSearchRef = useRef<(query: string) => Promise<void>>(async () => undefined);
  const openRowRef = useRef<(row: Pick<MailOverviewRow, "sourceId">) => Promise<void>>(
    async () => undefined,
  );

  const abortAll = useCallback(() => {
    for (const key of ["recent", "search", "open"] as const) {
      controllers.current[key]?.abort();
      controllers.current[key] = null;
    }
  }, []);

  // Declared before the load effect on purpose: both run in one commit, so a
  // reconnect to the same account (the same scope key) loads again.
  const loadedFor = useRef<string | null>(null);
  const restored = useRef<string | null>(null);
  useEffect(() => {
    generation.current += 1;
    loadedFor.current = null;
    restored.current = null;
    abortAll();
    dispatch({ type: "reset", state: freshState(scopeKey, ready ? cached() : null) });
    // Leaving the connected state (disconnect, revocation, sign-out) clears the
    // memory copy too, so a later reconnect starts from the provider.
    if (!ready && userId) clearMailOverviewMemory(userId);
    return abortAll;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new scope is the only trigger
  }, [scopeKey, ready]);

  const begin = useCallback((kind: "recent" | "search" | "open") => {
    controllers.current[kind]?.abort();
    const controller = new AbortController();
    controllers.current[kind] = controller;
    const ticket = ++tickets.current[kind];
    const mine = generation.current;
    const isCurrent = () =>
      mine === generation.current &&
      ticket === tickets.current[kind] &&
      !controller.signal.aborted;
    return { signal: controller.signal, isCurrent };
  }, []);

  /** A page for another Google account than the one shown is never applied. */
  const accountMatches = useCallback(
    (account: string) =>
      !live.current.expectedAccount || account === live.current.expectedAccount,
    [],
  );

  const request = useCallback(
    () => ({
      vaultOwnerToken: live.current.token ?? "",
      expectedAccount: live.current.expectedAccount,
    }),
    [],
  );

  const loadRecent = useCallback(
    async (options: { expanded?: boolean } = {}) => {
      if (!ready) return;
      const expanded = options.expanded ?? stateRef.current.recent.expanded;
      const { signal, isCurrent } = begin("recent");
      dispatch({ type: "recent_start", expanded });
      try {
        const page = await fetchRecentMail({
          ...request(),
          signal,
          limit: expanded ? MAIL_OVERVIEW_ROW_CAP : MAIL_OVERVIEW_INITIAL_ROWS,
        });
        if (!isCurrent()) return;
        if (!accountMatches(page.account)) {
          dispatch({
            type: "recent_failed",
            error: new MailOverviewError("account_changed"),
          });
          return;
        }
        const fetchedAt = Date.now();
        CacheService.getInstance().set<CachedRecent>(
          cacheKey,
          { page, expanded, fetchedAt },
          CACHE_TTL_MS,
        );
        dispatch({ type: "recent_done", page, fetchedAt });
      } catch (error) {
        const failure = asError(error);
        if (failure.reason === "aborted" || !isCurrent()) return;
        dispatch({ type: "recent_failed", error: failure });
      }
    },
    [accountMatches, begin, cacheKey, ready, request],
  );

  // Recent mail loads when the Overview is showing, independently of any
  // receipt scan, and revalidates what a cache painted.
  const placeKey = `${cacheKey}_place`;
  useEffect(() => {
    if (!ready || !active) return;
    if (loadedFor.current === scopeKey) return;
    loadedFor.current = scopeKey;
    void loadRecent();
    // Coming back from a reply (or another tab) returns to the same place: the
    // search that was submitted and the email that was open. Both are re-read.
    const place = CacheService.getInstance().peek<CachedPlace>(placeKey)?.data ?? null;
    restored.current = scopeKey;
    if (place?.query) void submitSearchRef.current(place.query);
    if (place?.openedSourceId) void openRowRef.current({ sourceId: place.openedSourceId });
  }, [active, loadRecent, placeKey, ready, scopeKey]);

  const searchQuery = state.search?.query ?? null;
  const openedSourceId = state.opened?.sourceId ?? null;
  useEffect(() => {
    if (!ready || restored.current !== scopeKey) return;
    CacheService.getInstance().set<CachedPlace>(
      placeKey,
      { query: searchQuery, openedSourceId },
      UI_TTL_MS,
    );
  }, [openedSourceId, placeKey, ready, scopeKey, searchQuery]);

  // A tab returning to the foreground never shows a list that has quietly aged.
  useEffect(() => {
    if (!ready || !active || typeof document === "undefined") return;
    const onVisible = () => {
      const current = stateRef.current;
      if (
        document.visibilityState === "visible" &&
        !current.search &&
        !current.opened &&
        !current.recent.loading &&
        !current.recent.refreshing &&
        Date.now() - current.recent.fetchedAt > REVALIDATE_AFTER_MS
      ) {
        void loadRecent();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [active, loadRecent, ready]);

  const submitSearch = useCallback(
    async (rawQuery: string) => {
      const query = rawQuery.trim();
      if (!ready || !query) return;
      const { signal, isCurrent } = begin("search");
      dispatch({ type: "search_start", query });
      try {
        const page = await searchMail({ ...request(), signal, query });
        if (!isCurrent()) return;
        if (!accountMatches(page.account)) {
          dispatch({ type: "search_failed", error: new MailOverviewError("account_changed") });
          return;
        }
        dispatch({ type: "search_done", page });
      } catch (error) {
        const failure = asError(error);
        if (failure.reason === "aborted" || !isCurrent()) return;
        dispatch({ type: "search_failed", error: failure });
      }
    },
    [accountMatches, begin, ready, request],
  );

  submitSearchRef.current = submitSearch;

  const clearSearch = useCallback(() => {
    controllers.current.search?.abort();
    controllers.current.open?.abort();
    tickets.current.search += 1;
    tickets.current.open += 1;
    dispatch({ type: "search_clear" });
  }, []);

  const openRow = useCallback(
    async (row: Pick<MailOverviewRow, "sourceId">) => {
      if (!ready) return;
      const { signal, isCurrent } = begin("open");
      dispatch({ type: "open_start", sourceId: row.sourceId });
      try {
        const { account, message } = await openMailMessage({
          ...request(),
          signal,
          sourceId: row.sourceId,
        });
        if (!isCurrent()) return;
        if (!accountMatches(account) || message.sourceId !== row.sourceId) {
          dispatch({ type: "open_failed", error: new MailOverviewError("account_changed") });
          return;
        }
        dispatch({ type: "open_done", message });
      } catch (error) {
        const failure = asError(error);
        if (failure.reason === "aborted" || !isCurrent()) return;
        dispatch({ type: "open_failed", error: failure });
      }
    },
    [accountMatches, begin, ready, request],
  );

  openRowRef.current = openRow;

  const closeOpened = useCallback(() => {
    controllers.current.open?.abort();
    tickets.current.open += 1;
    dispatch({ type: "open_close" });
  }, []);

  /** A fresh reply reference for the message on screen. Throws a typed error. */
  const replySource = useCallback(
    async (sourceId: string): Promise<MailReplySource> => {
      if (!ready) throw new MailOverviewError("auth_missing");
      const mine = generation.current;
      const { account, reply } = await prepareMailReply({ ...request(), sourceId });
      // The answer belongs to this scope or it is dropped: never a reply from
      // another account, and never one prepared after the screen moved on.
      if (mine !== generation.current || !accountMatches(account)) {
        throw new MailOverviewError("account_changed");
      }
      return reply;
    },
    [accountMatches, ready, request],
  );

  return {
    ready,
    recent: state.recent,
    search: state.search,
    opened: state.opened,
    viewMore: useCallback(() => loadRecent({ expanded: true }), [loadRecent]),
    refresh: useCallback(
      () => (stateRef.current.search ? submitSearch(stateRef.current.search.query) : loadRecent()),
      [loadRecent, submitSearch],
    ),
    retryOpen: useCallback(() => {
      const opened = stateRef.current.opened;
      const page = stateRef.current.search?.page ?? stateRef.current.recent.page;
      const row = page?.items.find((item) => item.sourceId === opened?.sourceId);
      if (row) void openRow(row);
    }, [openRow]),
    submitSearch,
    clearSearch,
    openRow,
    closeOpened,
    replySource,
  };
}

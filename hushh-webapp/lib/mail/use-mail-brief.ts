"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchMailBrief,
  fetchMailCompleted,
  type MailBrief,
  type MailCompleted,
} from "@/lib/mail/mail-brief-client";
import {
  MailOverviewError,
  type MailOverviewReason,
} from "@/lib/mail/mail-overview-client";
import { CacheService } from "@/lib/services/cache-service";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

const CACHE_PREFIX = "mail_overview_";
const CACHE_TTL_MS = 10 * 60_000;
/** A returning tab revalidates after this long, so the brief is never silently old. */
const REVALIDATE_AFTER_MS = 60_000;

// Credential changes purge protected display information synchronously. The
// brief lives in memory only, never in device storage.
subscribeVaultSessionEpoch(() => CacheService.getInstance().invalidatePattern(CACHE_PREFIX));

/** Failures that mean this account's mail cannot be shown: the old items are dropped. */
const ACCESS_LOSS: ReadonlySet<MailOverviewReason> = new Set([
  "auth_missing",
  "connect_required",
  "reconnect_required",
  "account_changed",
  "unavailable",
  "private_runtime",
]);

export type BriefPart<T> = {
  /** `idle` until the first read is asked for. */
  status: "idle" | "loading" | "ready" | "error";
  data: T | null;
  error: MailOverviewError | null;
  /** Data is on screen and a newer read is under way. */
  refreshing: boolean;
  /** When the last successful read finished. Failures never move it. */
  fetchedAt: number;
};

const EMPTY: BriefPart<never> = {
  status: "idle",
  data: null,
  error: null,
  refreshing: false,
  fetchedAt: 0,
};

type Cached = { brief: MailBrief | null; completed: MailCompleted | null; fetchedAt: number };

export type MailBriefState = {
  brief: BriefPart<MailBrief>;
  completed: BriefPart<MailCompleted>;
  refresh: () => void;
};

function cacheKey(userId: string, scope: string): string {
  return `${CACHE_PREFIX}${userId}_brief_${scope}`;
}

function failure(error: unknown): MailOverviewError {
  return error instanceof MailOverviewError ? error : new MailOverviewError("unknown", { cause: error });
}

/** What needs the owner, what changed, and what is confirmed done, for one mailbox. */
export function useMailBrief(input: {
  userId: string | null;
  /** A stable key for the connected mailbox, used for isolation and the cache. */
  accountKey: string | null;
  /** The Google account the screen is showing; the server refuses any other. */
  expectedAccount: string | null;
  vaultOwnerToken: string | null;
  connected: boolean;
  /** The Overview or Follow-ups tab is showing. */
  active: boolean;
}): MailBriefState {
  const { userId, accountKey, expectedAccount, vaultOwnerToken, connected, active } = input;
  const ready = Boolean(connected && userId && accountKey && vaultOwnerToken);
  const scope = `${userId ?? ""}|${accountKey ?? ""}|${expectedAccount ?? ""}`;
  const cachedNow = useCallback((): Cached | null => {
    if (!userId || !accountKey) return null;
    return CacheService.getInstance().peek<Cached>(cacheKey(userId, accountKey))?.data ?? null;
  }, [userId, accountKey]);

  const [state, setState] = useState<{
    scope: string;
    brief: BriefPart<MailBrief>;
    completed: BriefPart<MailCompleted>;
  }>(() => {
    const cached = cachedNow();
    return {
      scope,
      brief: cached?.brief
        ? { ...EMPTY, status: "ready", data: cached.brief, fetchedAt: cached.fetchedAt }
        : EMPTY,
      completed: cached?.completed
        ? { ...EMPTY, status: "ready", data: cached.completed, fetchedAt: cached.fetchedAt }
        : EMPTY,
    };
  });
  const flight = useRef<{ scope: string; controller: AbortController } | null>(null);
  const latestScope = useRef(scope);
  latestScope.current = scope;

  // A different owner, mailbox or account never inherits what the last one showed.
  if (state.scope !== scope) {
    const cached = cachedNow();
    setState({
      scope,
      brief: cached?.brief
        ? { ...EMPTY, status: "ready", data: cached.brief, fetchedAt: cached.fetchedAt }
        : EMPTY,
      completed: cached?.completed
        ? { ...EMPTY, status: "ready", data: cached.completed, fetchedAt: cached.fetchedAt }
        : EMPTY,
    });
  }

  const load = useCallback(() => {
    if (!ready || flight.current?.scope === scope) return;
    flight.current?.controller.abort();
    const controller = new AbortController();
    flight.current = { scope, controller };
    const token = vaultOwnerToken as string;
    const auth = { vaultOwnerToken: token, expectedAccount, signal: controller.signal };
    const current = () => latestScope.current === scope && !controller.signal.aborted;
    const begin = <T,>(part: BriefPart<T>): BriefPart<T> => ({
      ...part,
      status: part.data ? "ready" : "loading",
      refreshing: Boolean(part.data),
      error: null,
    });
    setState((value) => ({ ...value, brief: begin(value.brief), completed: begin(value.completed) }));

    const settle = <T extends { account: string }>(
      pick: "brief" | "completed",
      read: Promise<T>,
    ): Promise<void> =>
      read
        .then((data) => {
          if (!current()) return;
          // An answer from another account is never shown, whatever it contains.
          if (expectedAccount && data.account !== expectedAccount) {
            throw new MailOverviewError("account_changed");
          }
          const fetchedAt = Date.now();
          const cacheable = cachedNow();
          if (userId && accountKey) {
            CacheService.getInstance().set<Cached>(
              cacheKey(userId, accountKey),
              {
                brief: pick === "brief" ? (data as unknown as MailBrief) : (cacheable?.brief ?? null),
                completed:
                  pick === "completed" ? (data as unknown as MailCompleted) : (cacheable?.completed ?? null),
                fetchedAt,
              },
              CACHE_TTL_MS,
            );
          }
          setState((value) => ({
            ...value,
            [pick]: { status: "ready", data, error: null, refreshing: false, fetchedAt },
          }));
        })
        .catch((raw: unknown) => {
        if (!current()) return;
        const error = failure(raw);
        if (error.reason === "aborted") return;
        const loss = ACCESS_LOSS.has(error.reason);
        setState((value) => {
          const part = value[pick] as BriefPart<unknown>;
          return {
            ...value,
            [pick]: {
              status: "error",
              data: loss ? null : part.data,
              error,
              refreshing: false,
              // A failed read never claims fresher mail than what is on screen.
              fetchedAt: loss ? 0 : part.fetchedAt,
            },
          };
        });
      });

    void Promise.all([
      settle("brief", fetchMailBrief(auth)),
      settle("completed", fetchMailCompleted(auth)),
    ]).finally(() => {
      if (flight.current?.controller === controller) flight.current = null;
    });
  }, [ready, scope, vaultOwnerToken, expectedAccount, userId, accountKey, cachedNow]);

  // Read when the tab shows and nothing recent is held; never while it is hidden.
  useEffect(() => {
    if (!ready || !active) return;
    const newest = Math.min(
      state.brief.fetchedAt || 0,
      state.completed.fetchedAt || 0,
    );
    if (!newest || Date.now() - newest > REVALIDATE_AFTER_MS) load();
    // `state` is read only to decide whether a read is due; a finished read must not restart one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, active, scope, load]);

  // Leaving the screen, or changing owner or mailbox, ends any read still running.
  useEffect(
    () => () => {
      flight.current?.controller.abort();
      flight.current = null;
    },
    [scope],
  );

  const refresh = useCallback(() => {
    flight.current?.controller.abort();
    flight.current = null;
    load();
  }, [load]);

  return { brief: state.brief, completed: state.completed, refresh };
}

/** Forget what the brief held for one owner (sign-out, disconnect). */
export function clearMailBriefMemory(userId: string): void {
  CacheService.getInstance().invalidatePattern(`${CACHE_PREFIX}${userId}_brief_`);
}

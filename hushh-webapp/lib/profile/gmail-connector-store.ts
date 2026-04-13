"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { ROUTES } from "@/lib/navigation/routes";
import {
  GmailReceiptsService,
  type GmailConnectionStatus,
  type GmailSyncQueueResponse,
  type GmailSyncRun,
} from "@/lib/services/gmail-receipts-service";
import { getSessionItem, setSessionItem } from "@/lib/utils/session-storage";
import {
  resolveGmailConnectionPresentation,
  sanitizeGmailUserMessage,
} from "@/lib/profile/mail-flow";

const STORAGE_KEY = "kai_gmail_connector_cache_v1";
const STATUS_TTL_MS = 5 * 60 * 1000;
const ACTIVE_STATUS_TTL_MS = 30 * 1000;
const RUN_POLL_BASE_MS = 2_000;
const RUN_POLL_MAX_MS = 15_000;
const RUN_POLL_MAX_ATTEMPTS = 18;
const RUN_POLL_MAX_ELAPSED_MS = 2 * 60 * 1000;

type GmailConnectorTaskKind = "gmail_bootstrap" | "gmail_manual_sync" | "gmail_backfill";

interface PersistedGmailConnectorState {
  version: 1;
  entries: Record<string, GmailConnectorEntry>;
}

interface GmailConnectorEntry {
  status: GmailConnectionStatus | null;
  statusFetchedAt: number | null;
  statusError: string | null;
  syncRun: GmailSyncRun | null;
  syncRunFetchedAt: number | null;
  activeRunId: string | null;
  activeTaskId: string | null;
  activeTaskKind: GmailConnectorTaskKind | null;
  activeTaskRouteHref: string | null;
  suppressedRunId: string | null;
  isRefreshing: boolean;
  isPolling: boolean;
  pollAttempts: number;
}

export interface GmailConnectorView {
  status: GmailConnectionStatus | null;
  syncRun: GmailSyncRun | null;
  statusError: string | null;
  loadingStatus: boolean;
  refreshingStatus: boolean;
  syncingRun: boolean;
  isStale: boolean;
  activeRunId: string | null;
  activeTaskId: string | null;
  activeTaskKind: GmailConnectorTaskKind | null;
  activeTaskRouteHref: string | null;
  presentation: ReturnType<typeof resolveGmailConnectionPresentation>;
}

export interface UseGmailConnectorStatusOptions {
  userId: string | null | undefined;
  idTokenProvider?: (() => Promise<string>) | null;
  enabled?: boolean;
  routeHref?: string | null;
  refreshKey?: string;
  onSyncComplete?: (status: GmailConnectionStatus) => void;
}

export interface UseGmailConnectorStatusResult {
  status: GmailConnectionStatus | null;
  syncRun: GmailSyncRun | null;
  presentation: ReturnType<typeof resolveGmailConnectionPresentation>;
  loadingStatus: boolean;
  refreshingStatus: boolean;
  syncingRun: boolean;
  isStale: boolean;
  statusError: string | null;
  refreshStatus: (options?: { force?: boolean }) => Promise<GmailConnectionStatus | null>;
  disconnectGmail: () => Promise<GmailConnectionStatus | null>;
  syncNow: () => Promise<GmailSyncQueueResponse | null>;
  seedStatus: (status: GmailConnectionStatus) => void;
}

type Listener = () => void;

const listeners = new Set<Listener>();
const entries = new Map<string, GmailConnectorEntry>();
const connectorViewCache = new Map<
  string,
  {
    entry: GmailConnectorEntry | null;
    view: GmailConnectorView;
  }
>();
const inflightStatusRequests = new Map<string, Promise<GmailConnectionStatus | null>>();
const inflightRunPollers = new Map<string, AbortController>();

const EMPTY_CONNECTOR_VIEW: GmailConnectorView = {
  status: null,
  syncRun: null,
  statusError: null,
  loadingStatus: false,
  refreshingStatus: false,
  syncingRun: false,
  isStale: true,
  activeRunId: null,
  activeTaskId: null,
  activeTaskKind: null,
  activeTaskRouteHref: null,
  presentation: resolveGmailConnectionPresentation({
    status: null,
    loading: false,
    errorText: null,
  }),
};

function nowMs(): number {
  return Date.now();
}

function nowIso(): string {
  return new Date().toISOString();
}

function isTerminalRunStatus(value: unknown): boolean {
  const status = String(value || "").trim();
  return status === "completed" || status === "failed" || status === "canceled";
}

function hasActiveRun(run: GmailSyncRun | null | undefined): boolean {
  if (!run) return false;
  return run.status === "queued" || run.status === "running";
}

function isPassiveBackfillRun(run: GmailSyncRun | null | undefined): boolean {
  return hasActiveRun(run) && deriveConnectorTaskKind(run) === "gmail_backfill";
}

function hasBlockingRun(run: GmailSyncRun | null | undefined): boolean {
  return hasActiveRun(run) && !isPassiveBackfillRun(run);
}

function deriveConnectorTaskKind(run: GmailSyncRun | null | undefined): GmailConnectorTaskKind {
  const syncMode = String(run?.sync_mode || "").trim().toLowerCase();
  if (syncMode === "bootstrap" || syncMode === "recovery") return "gmail_bootstrap";
  if (syncMode === "backfill") return "gmail_backfill";
  const triggerSource = String(run?.trigger_source || "").trim().toLowerCase();
  if (triggerSource === "connect") return "gmail_bootstrap";
  if (triggerSource === "auto_daily" || triggerSource === "backfill") {
    return "gmail_backfill";
  }
  return "gmail_manual_sync";
}

function deriveTaskTitle(kind: GmailConnectorTaskKind): string {
  if (kind === "gmail_bootstrap") return "Scanning Gmail in the background";
  if (kind === "gmail_backfill") return "Fetching older receipts";
  return "Syncing Gmail receipts";
}

function deriveTaskDescription(kind: GmailConnectorTaskKind, run: GmailSyncRun | null): string {
  if (run?.status === "queued") {
    return "Kai is getting the Gmail sync ready. You can keep using the app.";
  }
  if (run?.status === "failed") {
    return sanitizeGmailUserMessage(run.error_message, {
      fallback: "We couldn't update your receipts. Please try again in a moment.",
      authFallback: "Reconnect Gmail to continue syncing your receipts.",
    });
  }
  if (kind === "gmail_bootstrap") {
    return "Kai is scanning your recent Gmail receipts in the background.";
  }
  if (kind === "gmail_backfill") {
    return "Kai is fetching older Gmail receipts without blocking the UI.";
  }
  return "Kai is syncing Gmail receipts without blocking the UI.";
}

function readPersistedState(): Record<string, GmailConnectorEntry> {
  const raw = getSessionItem(STORAGE_KEY);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedGmailConnectorState>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      return {};
    }

    const nextEntries: Record<string, GmailConnectorEntry> = {};
    for (const [userId, value] of Object.entries(parsed.entries)) {
      if (!userId.trim() || !value || typeof value !== "object") continue;
      nextEntries[userId] = {
        status: value.status || null,
        statusFetchedAt: typeof value.statusFetchedAt === "number" ? value.statusFetchedAt : null,
        statusError: typeof value.statusError === "string" ? value.statusError : null,
        syncRun: value.syncRun || null,
        syncRunFetchedAt:
          typeof value.syncRunFetchedAt === "number" ? value.syncRunFetchedAt : null,
        activeRunId: typeof value.activeRunId === "string" ? value.activeRunId : null,
        activeTaskId: typeof value.activeTaskId === "string" ? value.activeTaskId : null,
        activeTaskKind:
          value.activeTaskKind === "gmail_bootstrap" ||
          value.activeTaskKind === "gmail_manual_sync" ||
          value.activeTaskKind === "gmail_backfill"
            ? value.activeTaskKind
            : null,
        activeTaskRouteHref:
          typeof value.activeTaskRouteHref === "string" ? value.activeTaskRouteHref : null,
        suppressedRunId: typeof value.suppressedRunId === "string" ? value.suppressedRunId : null,
        isRefreshing: false,
        isPolling: false,
        pollAttempts: 0,
      };
    }
    return nextEntries;
  } catch {
    return {};
  }
}

function toPersistedEntry(entry: GmailConnectorEntry): GmailConnectorEntry {
  return {
    ...entry,
    isRefreshing: false,
    isPolling: false,
    pollAttempts: 0,
  };
}

function persistState(): void {
  const payload: PersistedGmailConnectorState = {
    version: 1,
    entries: Object.fromEntries(
      Array.from(entries.entries()).map(([userId, entry]) => [userId, toPersistedEntry(entry)])
    ),
  };
  setSessionItem(STORAGE_KEY, JSON.stringify(payload));
}

function getOrCreateEntry(userId: string): GmailConnectorEntry {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    throw new Error("Missing Gmail user id.");
  }

  const existing = entries.get(normalizedUserId);
  if (existing) return existing;

  const hydrated = readPersistedState()[normalizedUserId];
  const created: GmailConnectorEntry =
    hydrated || {
      status: null,
      statusFetchedAt: null,
      statusError: null,
      syncRun: null,
      syncRunFetchedAt: null,
      activeRunId: null,
      activeTaskId: null,
      activeTaskKind: null,
      activeTaskRouteHref: null,
      suppressedRunId: null,
      isRefreshing: false,
      isPolling: false,
      pollAttempts: 0,
    };
  entries.set(normalizedUserId, created);
  return created;
}

function emit(): void {
  persistState();
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[gmail-connector-store] listener error:", error);
    }
  }
}

function updateEntry(userId: string, next: Partial<GmailConnectorEntry>): GmailConnectorEntry {
  const entry = getOrCreateEntry(userId);
  const merged: GmailConnectorEntry = {
    ...entry,
    ...next,
  };
  entries.set(userId, merged);
  emit();
  return merged;
}

function isStatusFresh(entry: GmailConnectorEntry, force = false): boolean {
  if (force) return false;
  if (!entry.status || !entry.statusFetchedAt) return false;
  const ageMs = nowMs() - entry.statusFetchedAt;
  const ttlMs = hasActiveRun(entry.syncRun) ? ACTIVE_STATUS_TTL_MS : STATUS_TTL_MS;
  return ageMs <= ttlMs;
}

function statusErrorMessage(error: unknown, fallback: string): string {
  return sanitizeGmailUserMessage(error, { fallback });
}

function taskIdForRun(runId: string, kind: GmailConnectorTaskKind): string {
  return `gmail_${kind}_${runId}`;
}

function syncTaskRouteHref(routeHref?: string | null): string {
  if (routeHref && routeHref.trim()) return routeHref.trim();
  return `${ROUTES.PROFILE}?tab=account&panel=gmail`;
}

function seedTaskFromRun(
  userId: string,
  run: GmailSyncRun,
  options?: {
    routeHref?: string | null;
    taskKind?: GmailConnectorTaskKind | null;
  }
): string | null {
  const normalizedRunId = String(run.run_id || "").trim();
  if (!normalizedRunId) return null;

  const kind = options?.taskKind || deriveConnectorTaskKind(run);
  const taskId = taskIdForRun(normalizedRunId, kind);
  const routeHref = syncTaskRouteHref(options?.routeHref);
  const description = deriveTaskDescription(kind, run);
  const metadata = {
    runId: normalizedRunId,
    triggerSource: run.trigger_source,
    syncMode: run.sync_mode || null,
    listedCount: run.listed_count || 0,
    filteredCount: run.filtered_count || 0,
    syncedCount: run.synced_count || 0,
    extractedCount: run.extracted_count || 0,
  };

  const existing = AppBackgroundTaskService.getTask(taskId);
  if (!existing) {
    AppBackgroundTaskService.startTask({
      userId,
      kind,
      taskId,
      title: deriveTaskTitle(kind),
      description,
      routeHref,
      metadata,
      visibility: kind === "gmail_backfill" ? "passive" : "primary",
      groupLabel: "Gmail",
      autoClearAfterMs: kind === "gmail_backfill" ? 15_000 : 10_000,
    });
  } else {
    AppBackgroundTaskService.updateTask(taskId, {
      title: deriveTaskTitle(kind),
      description,
      routeHref,
      metadata,
      visibility: kind === "gmail_backfill" ? "passive" : "primary",
      groupLabel: "Gmail",
    });
  }

  return taskId;
}

function finishTaskFromRun(
  taskId: string | null,
  run: GmailSyncRun,
  options?: { taskKind?: GmailConnectorTaskKind | null }
): void {
  if (!taskId) return;
  const kind = options?.taskKind || deriveConnectorTaskKind(run);
  const message = deriveTaskDescription(kind, run);
  if (run.status === "failed") {
    const safeMessage = sanitizeGmailUserMessage(run.error_message, {
      fallback: "We couldn't update your receipts. Please try again in a moment.",
      authFallback: "Reconnect Gmail to continue syncing your receipts.",
    });
    AppBackgroundTaskService.failTask(taskId, safeMessage, safeMessage);
    return;
  }
  if (run.status === "canceled") {
    AppBackgroundTaskService.cancelTask(taskId, message);
    return;
  }
  AppBackgroundTaskService.completeTask(taskId, message, {
    runId: run.run_id,
    syncMode: run.sync_mode || null,
    syncedCount: run.synced_count || 0,
    extractedCount: run.extracted_count || 0,
  });
}

async function fetchStatusFromNetwork(params: {
  userId: string;
  idToken: string;
  force?: boolean;
  routeHref?: string | null;
  idTokenProvider?: (() => Promise<string>) | null;
  pollActiveRun?: boolean;
}): Promise<GmailConnectionStatus | null> {
  const normalizedUserId = String(params.userId || "").trim();
  if (!normalizedUserId) return null;

  const existingRequest = inflightStatusRequests.get(normalizedUserId);
  if (existingRequest && !params.force) {
    return existingRequest;
  }

  const entry = getOrCreateEntry(normalizedUserId);
  if (isStatusFresh(entry, Boolean(params.force))) {
    const activeRun = entry.syncRun || entry.status?.latest_run || null;
    if (
      params.pollActiveRun !== false &&
      params.idTokenProvider &&
      activeRun &&
      hasActiveRun(activeRun)
    ) {
      void pollSyncRun({
        userId: normalizedUserId,
        idTokenProvider: params.idTokenProvider,
        runId: activeRun.run_id,
        routeHref: params.routeHref,
        taskKind: deriveConnectorTaskKind(activeRun),
      });
    }
    return entry.status;
  }

  updateEntry(normalizedUserId, {
    isRefreshing: true,
    statusError: null,
  });

  const request = (params.force ? GmailReceiptsService.reconcile : GmailReceiptsService.getStatus)({
    idToken: params.idToken,
    userId: normalizedUserId,
  })
    .then((status) => {
      primeConnectorStatus({
        userId: normalizedUserId,
        status,
        routeHref: params.routeHref,
        source: "status",
        idTokenProvider: params.pollActiveRun === false ? null : params.idTokenProvider || null,
      });
      return status;
    })
    .catch(async (error) => {
      if (params.force) {
        try {
          const fallbackStatus = await GmailReceiptsService.getStatus({
            idToken: params.idToken,
            userId: normalizedUserId,
          });
          primeConnectorStatus({
            userId: normalizedUserId,
            status: fallbackStatus,
            routeHref: params.routeHref,
            source: "status",
            idTokenProvider: params.pollActiveRun === false ? null : params.idTokenProvider || null,
          });
          return fallbackStatus;
        } catch (fallbackError) {
          error = fallbackError;
        }
      }

      console.error("[gmail-connector-store] Failed to refresh Gmail status:", error);
      const nextError = statusErrorMessage(
        error,
        "We couldn't check your Gmail connection right now. Please try again in a moment."
      );
      updateEntry(normalizedUserId, {
        statusError: nextError,
      });
      return entry.status;
    })
    .finally(() => {
      inflightStatusRequests.delete(normalizedUserId);
      updateEntry(normalizedUserId, { isRefreshing: false });
    });

  inflightStatusRequests.set(normalizedUserId, request);
  return request;
}

async function pollSyncRun(params: {
  userId: string;
  idTokenProvider: () => Promise<string>;
  runId: string;
  routeHref?: string | null;
  taskKind?: GmailConnectorTaskKind | null;
  onComplete?: (status: GmailConnectionStatus | null) => void;
}): Promise<void> {
  const normalizedUserId = String(params.userId || "").trim();
  const normalizedRunId = String(params.runId || "").trim();
  if (!normalizedUserId || !normalizedRunId) return;

  const existingController = inflightRunPollers.get(normalizedUserId);
  if (existingController && !existingController.signal.aborted) {
    return;
  }

  const controller = new AbortController();
  inflightRunPollers.set(normalizedUserId, controller);
  updateEntry(normalizedUserId, {
    activeRunId: normalizedRunId,
    activeTaskKind: params.taskKind || null,
    isPolling: true,
    pollAttempts: 0,
  });

  let attempt = 0;
  const startedAtMs = nowMs();
  let handoffRunId: string | null = null;
  let handoffTaskKind: GmailConnectorTaskKind | null = null;
  let shouldStopPolling = false;
  try {
    while (!controller.signal.aborted && !shouldStopPolling) {
      attempt += 1;
      const elapsedMs = nowMs() - startedAtMs;
      if (attempt > RUN_POLL_MAX_ATTEMPTS || elapsedMs >= RUN_POLL_MAX_ELAPSED_MS) {
        updateEntry(normalizedUserId, {
          activeRunId: null,
          activeTaskId: null,
          activeTaskKind: null,
          suppressedRunId: normalizedRunId,
          isPolling: false,
        });
        try {
          await fetchStatusFromNetwork({
            userId: normalizedUserId,
            idToken: await params.idTokenProvider(),
            force: true,
            routeHref: params.routeHref,
            idTokenProvider: null,
            pollActiveRun: false,
          });
        } catch (refreshError) {
          console.warn(
            "[gmail-connector-store] Failed to refresh Gmail status after poll timeout:",
            refreshError
          );
        }
        shouldStopPolling = true;
        continue;
      }

      updateEntry(normalizedUserId, { pollAttempts: attempt });
      const idToken = await params.idTokenProvider();
      const payload = await GmailReceiptsService.getSyncRun({
        idToken,
        userId: normalizedUserId,
        runId: normalizedRunId,
      });
      if (controller.signal.aborted) return;

      const run = payload.run;
      const taskKind = params.taskKind || deriveConnectorTaskKind(run);
      const taskId = seedTaskFromRun(normalizedUserId, run, {
        routeHref: params.routeHref,
        taskKind,
      });

      updateEntry(normalizedUserId, {
        syncRun: run,
        syncRunFetchedAt: nowMs(),
        activeRunId: hasActiveRun(run) ? normalizedRunId : null,
        activeTaskId: taskId,
        activeTaskKind: taskKind,
        suppressedRunId: run.run_id === normalizedRunId && hasActiveRun(run) ? null : undefined,
      });

      if (isTerminalRunStatus(run.status)) {
        finishTaskFromRun(taskId, run, { taskKind });
        updateEntry(normalizedUserId, {
          isPolling: false,
        });
        try {
          const refreshed = await fetchStatusFromNetwork({
            userId: normalizedUserId,
            idToken,
            force: true,
            routeHref: params.routeHref,
            idTokenProvider: params.idTokenProvider,
            pollActiveRun: false,
          });
          params.onComplete?.(refreshed);
          const nextRun = refreshed?.latest_run;
          if (
            nextRun &&
            hasActiveRun(nextRun) &&
            nextRun.run_id &&
            nextRun.run_id !== normalizedRunId
          ) {
            handoffRunId = nextRun.run_id;
            handoffTaskKind = deriveConnectorTaskKind(nextRun);
          }
        } catch {
          params.onComplete?.(null);
        }
        shouldStopPolling = true;
        continue;
      }

      const delayMs = Math.min(RUN_POLL_MAX_MS, RUN_POLL_BASE_MS * Math.max(1, attempt));
      await new Promise<void>((resolve) => {
        const timeoutId = window.setTimeout(() => {
          window.clearTimeout(timeoutId);
          resolve();
        }, delayMs);
      });
    }
  } catch (error) {
    console.error("[gmail-connector-store] Failed to poll Gmail sync run:", error);
    const nextError = statusErrorMessage(
      error,
      "Something went wrong while syncing your emails. Please try again in a moment."
    );
    updateEntry(normalizedUserId, {
      statusError: nextError,
    });
  } finally {
    inflightRunPollers.delete(normalizedUserId);
    updateEntry(normalizedUserId, { isPolling: false });
  }

  if (
    handoffRunId &&
    !controller.signal.aborted &&
    inflightRunPollers.get(normalizedUserId) == null
  ) {
    void pollSyncRun({
      userId: normalizedUserId,
      idTokenProvider: params.idTokenProvider,
      runId: handoffRunId,
      routeHref: params.routeHref,
      taskKind: handoffTaskKind,
      onComplete: params.onComplete,
    });
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getConnectorView(userId: string | null | undefined): GmailConnectorView {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    return EMPTY_CONNECTOR_VIEW;
  }

  const entry = getOrCreateEntry(normalizedUserId);
  const cached = connectorViewCache.get(normalizedUserId);
  if (cached?.entry === entry) {
    return cached.view;
  }

  const rawStatus = entry?.status || null;
  const rawSyncRun = entry?.syncRun || rawStatus?.latest_run || null;
  const syncRun = rawSyncRun;
  const activeTaskKind =
    entry?.activeTaskKind || (syncRun && hasActiveRun(syncRun) ? deriveConnectorTaskKind(syncRun) : null);
  const isFresh = entry ? isStatusFresh(entry) : false;
  const isBackgroundRunStale =
    Boolean(entry?.suppressedRunId) &&
    rawSyncRun?.run_id === entry?.suppressedRunId &&
    hasActiveRun(rawSyncRun);
  const view: GmailConnectorView = {
    status: rawStatus,
    syncRun,
    statusError: entry?.statusError || null,
    loadingStatus: Boolean(entry?.isRefreshing) && !rawStatus,
    refreshingStatus: Boolean(entry?.isRefreshing) && Boolean(rawStatus),
    syncingRun: Boolean(
      (entry?.isPolling && activeTaskKind !== "gmail_backfill") || hasBlockingRun(syncRun)
    ),
    isStale: !isFresh || isBackgroundRunStale,
    activeRunId: entry?.activeRunId || syncRun?.run_id || null,
    activeTaskId: entry?.activeTaskId || null,
    activeTaskKind: activeTaskKind || null,
    activeTaskRouteHref: entry?.activeTaskRouteHref || null,
    presentation: resolveGmailConnectionPresentation({
      status: rawStatus,
      loading: Boolean(entry?.isRefreshing) && !rawStatus,
      errorText: entry?.statusError || null,
    }),
  };

  connectorViewCache.set(normalizedUserId, {
    entry,
    view,
  });
  return view;
}

export function primeConnectorStatus(params: {
  userId: string;
  status: GmailConnectionStatus;
  routeHref?: string | null;
  source?: "status" | "oauth_return" | "sync" | "disconnect";
  idTokenProvider?: (() => Promise<string>) | null;
}): void {
  const normalizedUserId = String(params.userId || "").trim();
  if (!normalizedUserId) return;

  const currentEntry = getOrCreateEntry(normalizedUserId);
  const latestRun = params.status.latest_run || null;
  const shouldKeepSuppressedRun =
    Boolean(currentEntry.suppressedRunId) &&
    latestRun?.run_id === currentEntry.suppressedRunId &&
    hasActiveRun(latestRun);
  const nextTaskKind =
    latestRun && hasActiveRun(latestRun)
      ? deriveConnectorTaskKind(latestRun)
      : null;
  const nextTaskId =
    latestRun && hasActiveRun(latestRun)
      ? taskIdForRun(latestRun.run_id, nextTaskKind || deriveConnectorTaskKind(latestRun))
      : null;

  updateEntry(normalizedUserId, {
    status: {
      ...params.status,
      status_refreshed_at: nowIso(),
      connection_state:
        params.status.connection_state ||
        (params.status.connected
          ? "connected"
          : params.status.revoked
            ? "needs_reauth"
            : "not_connected"),
      sync_state:
        params.status.sync_state ||
        (latestRun?.sync_mode === "backfill"
          ? "backfill_running"
          : latestRun?.sync_mode === "bootstrap" || latestRun?.sync_mode === "recovery"
            ? "bootstrap_running"
            : latestRun?.status === "running" || latestRun?.status === "queued"
              ? "syncing"
              : "idle"),
      bootstrap_state:
        params.source === "oauth_return" && latestRun && hasActiveRun(latestRun)
          ? "running"
          : params.status.bootstrap_state || null,
      watch_status: params.status.watch_status || "unknown",
      needs_reauth: params.status.needs_reauth ?? (params.status.revoked || false),
    },
    statusFetchedAt: nowMs(),
    statusError: null,
    syncRun: latestRun,
    syncRunFetchedAt: latestRun ? nowMs() : null,
    activeRunId: latestRun && hasActiveRun(latestRun) && !shouldKeepSuppressedRun ? latestRun.run_id : null,
    activeTaskId: shouldKeepSuppressedRun ? null : nextTaskId,
    activeTaskKind: shouldKeepSuppressedRun ? null : nextTaskKind,
    activeTaskRouteHref: params.routeHref || null,
    suppressedRunId: shouldKeepSuppressedRun ? currentEntry.suppressedRunId : null,
    isRefreshing: false,
  });

  if (latestRun && hasActiveRun(latestRun) && !shouldKeepSuppressedRun) {
    const taskKind = nextTaskKind || deriveConnectorTaskKind(latestRun);
    const taskId = seedTaskFromRun(normalizedUserId, latestRun, {
      routeHref: params.routeHref,
      taskKind,
    });
    updateEntry(normalizedUserId, {
      activeTaskId: taskId,
      activeTaskKind: taskKind,
      activeTaskRouteHref: params.routeHref || null,
    });
    if (params.idTokenProvider) {
      void pollSyncRun({
        userId: normalizedUserId,
        idTokenProvider: params.idTokenProvider,
        runId: latestRun.run_id,
        routeHref: params.routeHref,
        taskKind,
      });
    }
  }
}

export function clearConnectorStatus(userId: string): void {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return;
  entries.delete(normalizedUserId);
  connectorViewCache.delete(normalizedUserId);
  inflightStatusRequests.delete(normalizedUserId);
  const controller = inflightRunPollers.get(normalizedUserId);
  controller?.abort();
  inflightRunPollers.delete(normalizedUserId);
  emit();
}

export function useGmailConnectorStatus(
  options: UseGmailConnectorStatusOptions
): UseGmailConnectorStatusResult {
  const normalizedUserId = String(options.userId || "").trim() || null;
  const snapshot = useSyncExternalStore(
    subscribe,
    () => getConnectorView(normalizedUserId),
    () => getConnectorView(normalizedUserId)
  );
  const idTokenProvider = options.idTokenProvider || null;
  const routeHref = options.routeHref || `${ROUTES.PROFILE}?tab=account&panel=gmail`;
  const enabled = options.enabled !== false && Boolean(normalizedUserId);
  const refreshKey = options.refreshKey || "";

  const refreshStatus = useCallback(
    async (refreshOptions?: { force?: boolean }) => {
      if (!enabled || !normalizedUserId || !idTokenProvider) {
        return getConnectorView(normalizedUserId).status;
      }
      const idToken = await idTokenProvider();
      return fetchStatusFromNetwork({
        userId: normalizedUserId,
        idToken,
        force: refreshOptions?.force,
        routeHref,
        idTokenProvider,
      });
    },
    [enabled, idTokenProvider, normalizedUserId, routeHref]
  );

  const disconnectGmail = useCallback(async () => {
    if (!enabled || !normalizedUserId || !idTokenProvider) return null;
    const idToken = await idTokenProvider();
    const next = await GmailReceiptsService.disconnect({
      idToken,
      userId: normalizedUserId,
    });
    clearConnectorStatus(normalizedUserId);
    primeConnectorStatus({
      userId: normalizedUserId,
      status: next,
      routeHref,
      source: "disconnect",
    });
    return next;
  }, [enabled, idTokenProvider, normalizedUserId, routeHref]);

  const syncNow = useCallback(async () => {
    if (!enabled || !normalizedUserId || !idTokenProvider) return null;
    const idToken = await idTokenProvider();
    const response = await GmailReceiptsService.syncNow({
      idToken,
      userId: normalizedUserId,
    });

    const existingStatus = getConnectorView(normalizedUserId).status;
    const nextRun = response.run || existingStatus?.latest_run || null;
    if (nextRun) {
      primeConnectorStatus({
        userId: normalizedUserId,
        status: {
          ...(existingStatus || {
            configured: true,
            connected: true,
            status: "connected",
            scope_csv: "",
            auto_sync_enabled: true,
            revoked: false,
          }),
          latest_run: nextRun,
          last_sync_status: nextRun.status,
          connection_state: "connected",
          sync_state:
            nextRun.sync_mode === "backfill"
              ? "backfill_running"
              : nextRun.sync_mode === "bootstrap" || nextRun.sync_mode === "recovery"
                ? "bootstrap_running"
                : nextRun.status === "running" || nextRun.status === "queued"
                  ? "syncing"
                  : "idle",
          bootstrap_state:
            deriveConnectorTaskKind(nextRun) === "gmail_bootstrap" ? "running" : "completed",
          needs_reauth: false,
          status_refreshed_at: nowIso(),
        },
        routeHref,
        source: "sync",
        idTokenProvider,
      });
    } else {
      void refreshStatus({ force: true });
    }

    return response;
  }, [enabled, idTokenProvider, normalizedUserId, refreshStatus, routeHref]);

  useEffect(() => {
    if (!enabled || !normalizedUserId || !idTokenProvider) return;
    void refreshStatus({ force: false });
  }, [enabled, idTokenProvider, normalizedUserId, refreshKey, refreshStatus]);

  const presentation = useMemo(
    () =>
      resolveGmailConnectionPresentation({
        status: snapshot.status,
        loading: snapshot.loadingStatus,
        errorText:
          snapshot.statusError && !snapshot.status?.connected
            ? snapshot.statusError
            : null,
      }),
    [snapshot.loadingStatus, snapshot.status, snapshot.statusError]
  );

  return {
    status: snapshot.status,
    syncRun: snapshot.syncRun,
    presentation,
    loadingStatus: snapshot.loadingStatus,
    refreshingStatus: snapshot.refreshingStatus,
    syncingRun: snapshot.syncingRun,
    isStale: snapshot.isStale,
    statusError: snapshot.statusError,
    refreshStatus,
    disconnectGmail,
    syncNow,
    seedStatus: useCallback(
      (status: GmailConnectionStatus) => {
        if (!normalizedUserId) return;
        primeConnectorStatus({
          userId: normalizedUserId,
          status,
          routeHref,
          source: "oauth_return",
          idTokenProvider,
        });
      },
      [idTokenProvider, normalizedUserId, routeHref]
    ),
  };
}

// Hydrate the module cache once on load so transitions between profile screens stay instant.
if (typeof window !== "undefined") {
  const hydrated = readPersistedState();
  for (const [userId, entry] of Object.entries(hydrated)) {
    entries.set(userId, entry);
  }
}

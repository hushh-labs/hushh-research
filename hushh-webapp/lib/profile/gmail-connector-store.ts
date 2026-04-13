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
import { resolveGmailConnectionPresentation } from "@/lib/profile/mail-flow";

const STORAGE_KEY = "kai_gmail_connector_cache_v1";
const STATUS_TTL_MS = 5 * 60 * 1000;
const ACTIVE_STATUS_TTL_MS = 30 * 1000;
const RUN_POLL_BASE_MS = 2_000;
const RUN_POLL_MAX_MS = 15_000;
const RUN_POLL_MAX_ATTEMPTS = 45;

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
  if (kind === "gmail_backfill") return "Backfilling Gmail receipts";
  return "Syncing Gmail receipts";
}

function deriveTaskDescription(kind: GmailConnectorTaskKind, run: GmailSyncRun | null): string {
  if (run?.status === "queued") {
    return "Kai is getting the Gmail sync ready. You can keep using the app.";
  }
  if (run?.status === "failed") {
    return run.error_message || "Gmail sync failed.";
  }
  if (kind === "gmail_bootstrap") {
    return "Kai is scanning your recent Gmail receipts in the background.";
  }
  if (kind === "gmail_backfill") {
    return "Kai is filling in older Gmail receipts without blocking the UI.";
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
        isRefreshing: Boolean(value.isRefreshing),
        isPolling: Boolean(value.isPolling),
        pollAttempts: typeof value.pollAttempts === "number" ? value.pollAttempts : 0,
      };
    }
    return nextEntries;
  } catch {
    return {};
  }
}

function persistState(): void {
  const payload: PersistedGmailConnectorState = {
    version: 1,
    entries: Object.fromEntries(entries.entries()),
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
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return fallback;
}

function taskIdForRun(runId: string, kind: GmailConnectorTaskKind): string {
  return `gmail_${kind}_${runId}`;
}

function syncTaskRouteHref(routeHref?: string | null): string {
  if (routeHref && routeHref.trim()) return routeHref.trim();
  return `${ROUTES.PROFILE}?panel=gmail`;
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
    AppBackgroundTaskService.failTask(taskId, run.error_message || message, message);
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
}): Promise<GmailConnectionStatus | null> {
  const normalizedUserId = String(params.userId || "").trim();
  if (!normalizedUserId) return null;

  const existingRequest = inflightStatusRequests.get(normalizedUserId);
  if (existingRequest) {
    return existingRequest;
  }

  const entry = getOrCreateEntry(normalizedUserId);
  if (isStatusFresh(entry, Boolean(params.force))) {
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
      });
      return status;
    })
    .catch((error) => {
      const nextError = statusErrorMessage(error, "Failed to load Gmail connector status.");
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
  try {
    while (!controller.signal.aborted && attempt < RUN_POLL_MAX_ATTEMPTS) {
      attempt += 1;
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
          });
          params.onComplete?.(refreshed);
        } catch {
          params.onComplete?.(null);
        }
        return;
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
    const nextError = statusErrorMessage(error, "Gmail sync polling failed.");
    updateEntry(normalizedUserId, {
      statusError: nextError,
    });
  } finally {
    inflightRunPollers.delete(normalizedUserId);
    updateEntry(normalizedUserId, { isPolling: false });
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

  const status = entry?.status || null;
  const syncRun = entry?.syncRun || status?.latest_run || null;
  const isFresh = entry ? isStatusFresh(entry) : false;
  const view: GmailConnectorView = {
    status,
    syncRun,
    statusError: entry?.statusError || null,
    loadingStatus: Boolean(entry?.isRefreshing) && !status,
    refreshingStatus: Boolean(entry?.isRefreshing) && Boolean(status),
    syncingRun: Boolean(entry?.isPolling || hasActiveRun(syncRun)),
    isStale: !isFresh,
    activeRunId: entry?.activeRunId || syncRun?.run_id || null,
    activeTaskId: entry?.activeTaskId || null,
    activeTaskKind: entry?.activeTaskKind || null,
    activeTaskRouteHref: entry?.activeTaskRouteHref || null,
    presentation: resolveGmailConnectionPresentation({
      status,
      loading: Boolean(entry?.isRefreshing) && !status,
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

  const latestRun = params.status.latest_run || null;
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
    activeRunId: latestRun && hasActiveRun(latestRun) ? latestRun.run_id : null,
    activeTaskId: nextTaskId,
    activeTaskKind: nextTaskKind,
    activeTaskRouteHref: params.routeHref || null,
    isRefreshing: false,
  });

  if (latestRun && hasActiveRun(latestRun)) {
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
  const routeHref = options.routeHref || `${ROUTES.PROFILE}?panel=gmail`;
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

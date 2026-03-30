"use client";

import { getSessionItem, setSessionItem } from "@/lib/utils/session-storage";

const APP_BACKGROUND_TASKS_KEY = "kai_app_background_tasks_v1";
const DEFAULT_PASSIVE_VISIBLE_AFTER_MS = 750;
const DEFAULT_PASSIVE_AUTO_CLEAR_AFTER_MS = 10_000;

export type AppBackgroundTaskStatus = "running" | "completed" | "failed" | "canceled";
export type AppBackgroundTaskVisibility = "primary" | "passive";
export type AppBackgroundTaskMetadata = Record<string, unknown>;

export interface AppBackgroundTask {
  taskId: string;
  userId: string;
  kind: string;
  title: string;
  description: string;
  status: AppBackgroundTaskStatus;
  routeHref: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  dismissedAt: string | null;
  metadata: AppBackgroundTaskMetadata | null;
  visibility: AppBackgroundTaskVisibility;
  groupLabel: string | null;
  visibleAfterMs: number;
  autoClearAfterMs: number;
}

interface PersistedAppBackgroundTaskState {
  version: 1;
  tasks: AppBackgroundTask[];
}

export interface AppBackgroundTaskState {
  tasks: AppBackgroundTask[];
}

type Listener = (state: AppBackgroundTaskState) => void;

function nowIso(): string {
  return new Date().toISOString();
}

function createTaskId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function normalizeVisibility(value: unknown): AppBackgroundTaskVisibility {
  return value === "passive" ? "passive" : "primary";
}

function normalizeDelay(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function isAppBackgroundTaskVisible(
  task: AppBackgroundTask,
  now = Date.now()
): boolean {
  if (task.dismissedAt) {
    return false;
  }
  if (task.visibility !== "passive") {
    return true;
  }
  if (task.status !== "running") {
    return true;
  }
  const startedAt = Date.parse(task.startedAt);
  if (Number.isNaN(startedAt)) {
    return true;
  }
  return now - startedAt >= task.visibleAfterMs;
}

class AppBackgroundTaskManager {
  private tasks = new Map<string, AppBackgroundTask>();
  private listeners = new Set<Listener>();
  private visibilityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private autoClearTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    this.hydrate();
  }

  private clearVisibilityTimer(taskId: string): void {
    const timer = this.visibilityTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.visibilityTimers.delete(taskId);
    }
  }

  private clearAutoClearTimer(taskId: string): void {
    const timer = this.autoClearTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.autoClearTimers.delete(taskId);
    }
  }

  private scheduleVisibilityEmit(task: AppBackgroundTask): void {
    this.clearVisibilityTimer(task.taskId);
    if (
      task.visibility !== "passive" ||
      task.status !== "running" ||
      task.dismissedAt ||
      task.visibleAfterMs <= 0 ||
      isAppBackgroundTaskVisible(task)
    ) {
      return;
    }
    const startedAt = Date.parse(task.startedAt);
    if (Number.isNaN(startedAt)) {
      return;
    }
    const delay = Math.max(0, startedAt + task.visibleAfterMs - Date.now());
    const timer = setTimeout(() => {
      this.visibilityTimers.delete(task.taskId);
      this.emit();
    }, delay);
    this.visibilityTimers.set(task.taskId, timer);
  }

  private scheduleAutoClear(task: AppBackgroundTask): void {
    this.clearAutoClearTimer(task.taskId);
    if (
      task.visibility !== "passive" ||
      task.dismissedAt ||
      task.autoClearAfterMs <= 0 ||
      (task.status !== "completed" && task.status !== "canceled")
    ) {
      return;
    }
    const completedAt = Date.parse(task.completedAt || task.updatedAt);
    if (Number.isNaN(completedAt)) {
      return;
    }
    const delay = Math.max(0, completedAt + task.autoClearAfterMs - Date.now());
    const timer = setTimeout(() => {
      this.autoClearTimers.delete(task.taskId);
      this.dismissTask(task.taskId);
    }, delay);
    this.autoClearTimers.set(task.taskId, timer);
  }

  private hydrate(): void {
    const raw = getSessionItem(APP_BACKGROUND_TASKS_KEY);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as Partial<PersistedAppBackgroundTaskState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) return;

      for (const task of parsed.tasks) {
        if (!task || typeof task !== "object") continue;
        if (!task.taskId || !task.userId || !task.kind) continue;
        this.tasks.set(task.taskId, {
          ...task,
          status:
            task.status === "completed" ||
            task.status === "failed" ||
            task.status === "canceled"
              ? task.status
              : "running",
          routeHref: task.routeHref || null,
          completedAt: task.completedAt || null,
          error: task.error || null,
          dismissedAt: task.dismissedAt || null,
          metadata:
            task.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata)
              ? (task.metadata as AppBackgroundTaskMetadata)
              : null,
          visibility: normalizeVisibility(task.visibility),
          groupLabel: typeof task.groupLabel === "string" ? task.groupLabel : null,
          visibleAfterMs: normalizeDelay(
            task.visibleAfterMs,
            DEFAULT_PASSIVE_VISIBLE_AFTER_MS
          ),
          autoClearAfterMs: normalizeDelay(
            task.autoClearAfterMs,
            DEFAULT_PASSIVE_AUTO_CLEAR_AFTER_MS
          ),
        });
      }
      for (const task of this.tasks.values()) {
        this.scheduleVisibilityEmit(task);
        this.scheduleAutoClear(task);
      }
    } catch {
      // Ignore malformed cache
    }
  }

  private persist(): void {
    const payload: PersistedAppBackgroundTaskState = {
      version: 1,
      tasks: Array.from(this.tasks.values()),
    };
    setSessionItem(APP_BACKGROUND_TASKS_KEY, JSON.stringify(payload));
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private upsert(task: AppBackgroundTask): AppBackgroundTask {
    const existing = this.tasks.get(task.taskId);
    const merged: AppBackgroundTask = {
      ...existing,
      ...task,
      updatedAt: nowIso(),
    };
    this.tasks.set(merged.taskId, merged);
    this.scheduleVisibilityEmit(merged);
    this.scheduleAutoClear(merged);
    this.persist();
    this.emit();
    return merged;
  }

  getState(): AppBackgroundTaskState {
    const tasks = Array.from(this.tasks.values()).sort((a, b) => {
      const aTs = Date.parse(a.updatedAt);
      const bTs = Date.parse(b.updatedAt);
      return bTs - aTs;
    });
    return { tasks };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  startTask(params: {
    userId: string;
    kind: string;
    title: string;
    description: string;
    routeHref?: string;
    taskId?: string;
    metadata?: AppBackgroundTaskMetadata | null;
    visibility?: AppBackgroundTaskVisibility;
    groupLabel?: string | null;
    visibleAfterMs?: number;
    autoClearAfterMs?: number;
  }): string {
    const taskId = params.taskId || createTaskId(params.kind || "task");
    const startedAt = nowIso();
    this.upsert({
      taskId,
      userId: params.userId,
      kind: params.kind,
      title: params.title,
      description: params.description,
      status: "running",
      routeHref: params.routeHref || null,
      startedAt,
      updatedAt: startedAt,
      completedAt: null,
      error: null,
      dismissedAt: null,
      metadata:
        params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
          ? params.metadata
          : null,
      visibility: normalizeVisibility(params.visibility),
      groupLabel: typeof params.groupLabel === "string" ? params.groupLabel : null,
      visibleAfterMs: normalizeDelay(
        params.visibleAfterMs,
        DEFAULT_PASSIVE_VISIBLE_AFTER_MS
      ),
      autoClearAfterMs: normalizeDelay(
        params.autoClearAfterMs,
        DEFAULT_PASSIVE_AUTO_CLEAR_AFTER_MS
      ),
    });
    return taskId;
  }

  completeTask(
    taskId: string,
    description?: string,
    metadata?: AppBackgroundTaskMetadata | null
  ): void {
    const existing = this.tasks.get(taskId);
    if (!existing) return;
    this.upsert({
      ...existing,
      status: "completed",
      description: description ?? existing.description,
      completedAt: nowIso(),
      error: null,
      metadata:
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? metadata
          : existing.metadata,
    });
  }

  failTask(
    taskId: string,
    error: string,
    description?: string,
    metadata?: AppBackgroundTaskMetadata | null
  ): void {
    const existing = this.tasks.get(taskId);
    if (!existing) return;
    this.upsert({
      ...existing,
      status: "failed",
      description: description ?? existing.description,
      completedAt: nowIso(),
      error: error || "Task failed",
      metadata:
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? metadata
          : existing.metadata,
      visibility: "primary",
      groupLabel: null,
    });
  }

  cancelTask(
    taskId: string,
    description?: string,
    metadata?: AppBackgroundTaskMetadata | null
  ): void {
    const existing = this.tasks.get(taskId);
    if (!existing) return;
    this.upsert({
      ...existing,
      status: "canceled",
      description: description ?? existing.description,
      completedAt: nowIso(),
      error: null,
      metadata:
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? metadata
          : existing.metadata,
    });
  }

  updateTask(
    taskId: string,
    updates: {
      title?: string;
      description?: string;
      routeHref?: string | null;
      metadata?: AppBackgroundTaskMetadata | null;
      visibility?: AppBackgroundTaskVisibility;
      groupLabel?: string | null;
    }
  ): void {
    const existing = this.tasks.get(taskId);
    if (!existing) return;
    this.upsert({
      ...existing,
      title:
        typeof updates.title === "string" && updates.title.trim().length > 0
          ? updates.title
          : existing.title,
      description:
        typeof updates.description === "string" && updates.description.trim().length > 0
          ? updates.description
          : existing.description,
      routeHref:
        updates.routeHref === undefined
          ? existing.routeHref
          : updates.routeHref,
      metadata:
        updates.metadata === undefined
          ? existing.metadata
          : updates.metadata && typeof updates.metadata === "object" && !Array.isArray(updates.metadata)
            ? updates.metadata
            : null,
      visibility:
        updates.visibility === undefined
          ? existing.visibility
          : normalizeVisibility(updates.visibility),
      groupLabel:
        updates.groupLabel === undefined
          ? existing.groupLabel
          : typeof updates.groupLabel === "string"
            ? updates.groupLabel
            : null,
    });
  }

  dismissTask(taskId: string): void {
    const existing = this.tasks.get(taskId);
    if (!existing) return;
    this.clearVisibilityTimer(taskId);
    this.clearAutoClearTimer(taskId);
    this.upsert({
      ...existing,
      dismissedAt: nowIso(),
    });
  }

  hasRunningTask(userId: string, kind?: string): boolean {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return false;
    const normalizedKind = typeof kind === "string" && kind.trim().length > 0
      ? kind.trim()
      : null;
    for (const task of this.tasks.values()) {
      if (task.userId !== normalizedUserId) continue;
      if (task.status !== "running") continue;
      if (task.dismissedAt) continue;
      if (normalizedKind && task.kind !== normalizedKind) continue;
      return true;
    }
    return false;
  }

  getTask(taskId: string): AppBackgroundTask | null {
    return this.tasks.get(taskId) ?? null;
  }
}

export const AppBackgroundTaskService = new AppBackgroundTaskManager();

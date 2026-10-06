"use client";

/**
 * Owner-authored To-do List state.
 *
 * Owner-added items are encrypted in a dedicated dynamic PKM domain. Calendar
 * events deliberately do not live here: Calendar remains their source of
 * truth and the To-do List only renders its safe, read-only projection.
 */

import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import {
  PkmWriteCoordinator,
  type PkmWriteCoordinatorResult,
} from "@/lib/services/pkm-write-coordinator";

export const TODO_LIST_PKM_DOMAIN = "one_todos" as const;

export const TODO_CATEGORIES = [
  "fitness",
  "relationships",
  "finance",
  "career",
  "interests",
  "productivity",
  "other",
] as const;

export type TodoCategory = (typeof TODO_CATEGORIES)[number];
export type TodoCadence = "once" | "daily" | "weekly";

export type TodoItem = {
  id: string;
  title: string;
  category: TodoCategory;
  cadence: TodoCadence;
  dueOn: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TodoListState = {
  tasks: TodoItem[];
};

type WriteParams = {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
};

type PrivateTodoData = {
  tasks?: unknown;
  updatedAt?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCategory(value: unknown): TodoCategory {
  return (TODO_CATEGORIES as readonly string[]).includes(String(value))
    ? (value as TodoCategory)
    : "other";
}

function normalizeCadence(value: unknown): TodoCadence {
  return value === "daily" || value === "weekly" ? value : "once";
}

function normalizeDueOn(value: unknown): string | null {
  const dueOn = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(dueOn) ? dueOn : null;
}

function normalizeItem(value: unknown): TodoItem | null {
  if (!isRecord(value)) return null;
  const id = String(value.id ?? "").trim();
  const title = String(value.title ?? "").trim().replace(/\s+/g, " ");
  const createdAt = String(value.createdAt ?? "").trim();
  const updatedAt = String(value.updatedAt ?? "").trim();
  if (!id || !title || !createdAt || !updatedAt) return null;

  const completedAt = String(value.completedAt ?? "").trim();
  return {
    id,
    title: title.slice(0, 240),
    category: normalizeCategory(value.category),
    cadence: normalizeCadence(value.cadence),
    dueOn: normalizeDueOn(value.dueOn),
    completedAt: completedAt || null,
    createdAt,
    updatedAt,
  };
}

function privateTodoData(domainData: Record<string, unknown> | null | undefined): PrivateTodoData {
  const candidate = domainData?._private;
  return isRecord(candidate) ? candidate : {};
}

/**
 * Completed items stay in the encrypted history but are excluded from the
 * active To-do List. This lets completion feel immediate without discarding
 * the owner's record.
 */
export function openTodoItems(tasks: TodoItem[]): TodoItem[] {
  return tasks.filter((task) => !task.completedAt);
}

export function readTodoListState(
  domainData: Record<string, unknown> | null | undefined,
): TodoListState {
  const privateData = privateTodoData(domainData);
  const tasks = Array.isArray(privateData.tasks)
    ? privateData.tasks.map(normalizeItem).filter((item): item is TodoItem => item !== null)
    : [];

  return {
    tasks: tasks
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 250),
  };
}

function privateDomainData(
  current: Record<string, unknown>,
  tasks: TodoItem[],
  updatedAt: string,
): Record<string, unknown> {
  const privateData = privateTodoData(current);
  return {
    ...current,
    _private: {
      ...privateData,
      tasks: tasks.slice(0, 250),
      updatedAt,
    },
  };
}

async function write(
  params: WriteParams,
  source: string,
  idempotencyScope: string,
  update: (current: TodoListState) => TodoItem[],
): Promise<PkmWriteCoordinatorResult> {
  return PkmWriteCoordinator.saveMergedDomain({
    userId: params.userId,
    domain: TODO_LIST_PKM_DOMAIN,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    confirmation: { confirmedByUser: true, surface: "web", source },
    idempotencyScope,
    build: (context) => {
      const currentDomain = (context.currentDomainData ?? {}) as Record<string, unknown>;
      const state = readTodoListState(currentDomain);
      const updatedAt = new Date().toISOString();
      const tasks = update(state).slice(0, 250);
      const completedCount = tasks.filter((task) => task.completedAt).length;

      return {
        domainData: privateDomainData(currentDomain, tasks, updatedAt),
        // This is deliberately content-free metadata. Titles, dates, goal
        // categories, and completion history remain under `_private`.
        summary: {
          item_count: tasks.length,
          completed_item_count: completedCount,
          open_item_count: tasks.length - completedCount,
          last_updated: updatedAt,
        },
      };
    },
  });
}

export const TodoListPkmService = {
  async load(params: WriteParams): Promise<TodoListState> {
    const domainData = await PersonalKnowledgeModelService.loadDomainData({
      userId: params.userId,
      domain: TODO_LIST_PKM_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch(() => null);
    return readTodoListState(domainData);
  },

  add(
    params: WriteParams & {
      task: TodoItem;
    },
  ) {
    return write(
      params,
      "one_todo_list_owner_confirmed_add",
      `one_todo_list:add:${params.task.id}`,
      (current) =>
        current.tasks.some((task) => task.id === params.task.id)
          ? current.tasks
          : [params.task, ...current.tasks],
    );
  },

  setCompletion(
    params: WriteParams & {
      taskId: string;
      completedAt: string | null;
      updatedAt: string;
    },
  ) {
    return write(
      params,
      "one_todo_list_owner_confirmed_completion",
      `one_todo_list:completion:${params.taskId}:${params.updatedAt}`,
      (current) =>
        current.tasks.map((task) =>
          task.id === params.taskId
            ? { ...task, completedAt: params.completedAt, updatedAt: params.updatedAt }
            : task,
        ),
    );
  },

  remove(
    params: WriteParams & {
      taskId: string;
    },
  ) {
    return write(
      params,
      "one_todo_list_owner_confirmed_remove",
      `one_todo_list:remove:${params.taskId}`,
      (current) => current.tasks.filter((task) => task.id !== params.taskId),
    );
  },
};

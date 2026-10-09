"use client";

/**
 * Private To-do List persistence.
 *
 * Tasks are stored inside the owner's encrypted `one_todos` PKM domain. The
 * Calendar provider remains the source of truth for an event; automatic task
 * records only carry the owner's completion or dismissal state and a safe
 * presentation snapshot. This gives other private-agent integrations one
 * common creation seam without introducing a second plaintext task database.
 */

import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import {
  PkmWriteCoordinator,
  type PkmWriteCoordinatorResult,
} from "@/lib/services/pkm-write-coordinator";

export const TODO_LIST_PKM_DOMAIN = "one_todos" as const;

export type TodoType = "automatic" | "manual";
export type TodoStatus = "pending" | "done" | "deleted";
export type TodoSourceAgent = "calendar" | null;

/**
 * The private task model. `userId` is intentionally not duplicated in the
 * value: the encrypted PKM domain is already owner-scoped by user id.
 */
export type TodoItem = {
  id: string;
  title: string;
  type: TodoType;
  date: string | null;
  time: string | null;
  status: TodoStatus;
  sourceAgent: TodoSourceAgent;
  sourceId: string | null;
  link: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
};

export type CreateTodoInput = {
  id?: string;
  title: string;
  type?: TodoType;
  date?: string | null;
  time?: string | null;
  source?: TodoSourceAgent;
  sourceId?: string | null;
  link?: string | null;
  notes?: string | null;
};

export type CalendarTodoEvent = {
  id?: string | null;
  title?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  conference_url?: string | null;
  conferenceUrl?: string | null;
};

export type TodoListState = {
  tasks: TodoItem[];
};

export type TodoWriteParams = {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
};

type PrivateTodoData = {
  tasks?: unknown;
  updatedAt?: unknown;
};

type MutableTodoFields = Pick<TodoItem, "title" | "date" | "time" | "notes">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maximum);
}

function normalizeDate(value: unknown): string | null {
  const date = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function normalizeTime(value: unknown): string | null {
  const time = text(value, 5);
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null;
}

function normalizeLink(value: unknown): string | null {
  const candidate = text(value, 1_500);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeType(value: unknown): TodoType {
  return value === "automatic" ? "automatic" : "manual";
}

function normalizeStatus(
  value: unknown,
  completedAt: string | null,
  deletedAt: string | null,
): TodoStatus {
  if (value === "deleted" || deletedAt) return "deleted";
  if (value === "done" || completedAt) return "done";
  return "pending";
}

function normalizeSource(value: unknown, type: TodoType): TodoSourceAgent {
  return value === "calendar" || type === "automatic" ? "calendar" : null;
}

function privateTodoData(
  domainData: Record<string, unknown> | null | undefined,
): PrivateTodoData {
  const candidate = domainData?._private;
  return isRecord(candidate) ? candidate : {};
}

function normalizeItem(value: unknown): TodoItem | null {
  if (!isRecord(value)) return null;
  const id = text(value.id, 240);
  const title = text(value.title, 240);
  const createdAt = text(value.createdAt, 64);
  const updatedAt = text(value.updatedAt, 64);
  if (!id || !title || !createdAt || !updatedAt) return null;

  const completedAt = text(value.completedAt, 64) || null;
  const deletedAt = text(value.deletedAt, 64) || null;
  const type = normalizeType(value.type);

  return {
    id,
    title,
    type,
    date: normalizeDate(value.date ?? value.dueOn),
    time: normalizeTime(value.time),
    status: normalizeStatus(value.status, completedAt, deletedAt),
    sourceAgent: normalizeSource(value.sourceAgent ?? value.source, type),
    sourceId: text(value.sourceId ?? value.calendarEventId, 240) || null,
    link: normalizeLink(value.link),
    notes: text(value.notes, 1_200) || null,
    createdAt,
    updatedAt,
    completedAt,
    deletedAt,
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

function nowTodoId(): string {
  return `todo_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function automaticTodoId(sourceId: string): string {
  return `calendar_${sourceId}`.slice(0, 240);
}

/** Build a normalized task before it enters the encrypted write coordinator. */
export function buildTodo(
  input: CreateTodoInput,
  now = new Date().toISOString(),
): TodoItem {
  const type = input.type === "automatic" ? "automatic" : "manual";
  const sourceId = text(input.sourceId, 240) || null;
  const id =
    text(input.id, 240) ||
    (type === "automatic" && sourceId
      ? automaticTodoId(sourceId)
      : nowTodoId());
  const sourceAgent =
    input.source === "calendar" || type === "automatic" ? "calendar" : null;

  return {
    id,
    title: text(input.title, 240),
    type,
    date: normalizeDate(input.date),
    time: normalizeTime(input.time),
    status: "pending",
    sourceAgent,
    sourceId,
    link: normalizeLink(input.link),
    notes: text(input.notes, 1_200) || null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    deletedAt: null,
  };
}

/**
 * Converts a confirmed Calendar event into the common private-agent To-do
 * input. It deliberately accepts only the presentation fields used by the
 * list; attendees, descriptions, locations, and Calendar HTML links never
 * move into the task record.
 */
export function calendarTodoInput(
  event: CalendarTodoEvent,
): CreateTodoInput | null {
  const sourceId = text(event.id, 240);
  if (!sourceId) return null;
  const title = text(event.title, 240) || "Scheduled meeting";
  const link = event.conference_url ?? event.conferenceUrl ?? null;
  const allDayDate = normalizeDate(event.start?.date);
  if (allDayDate) {
    return {
      id: automaticTodoId(sourceId),
      title,
      type: "automatic",
      date: allDayDate,
      time: null,
      source: "calendar",
      sourceId,
      link,
    };
  }

  const startText = event.start?.dateTime;
  if (!startText) return null;
  const start = new Date(startText);
  if (Number.isNaN(start.getTime())) return null;
  const date = [
    start.getFullYear(),
    String(start.getMonth() + 1).padStart(2, "0"),
    String(start.getDate()).padStart(2, "0"),
  ].join("-");
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(start);
  return {
    id: automaticTodoId(sourceId),
    title,
    type: "automatic",
    date,
    time,
    source: "calendar",
    sourceId,
    link,
  };
}

/** Active rows are pending tasks. Completed and dismissed rows stay private. */
export function openTodoItems(tasks: TodoItem[]): TodoItem[] {
  return tasks.filter((task) => task.status === "pending");
}

export function completedTodoItems(tasks: TodoItem[]): TodoItem[] {
  return tasks.filter((task) => task.status === "done");
}

export function readTodoListState(
  domainData: Record<string, unknown> | null | undefined,
): TodoListState {
  const privateData = privateTodoData(domainData);
  const tasks = Array.isArray(privateData.tasks)
    ? privateData.tasks
        .map(normalizeItem)
        .filter((item): item is TodoItem => item !== null)
    : [];

  return {
    tasks: tasks
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 250),
  };
}

async function write(
  params: TodoWriteParams,
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
      const currentDomain = (context.currentDomainData ?? {}) as Record<
        string,
        unknown
      >;
      const state = readTodoListState(currentDomain);
      const updatedAt = new Date().toISOString();
      const tasks = update(state).slice(0, 250);
      const completedCount = tasks.filter(
        (task) => task.status === "done",
      ).length;

      return {
        domainData: privateDomainData(currentDomain, tasks, updatedAt),
        // Consumer details stay entirely under `_private`; the discovery
        // projection carries counters only.
        summary: {
          item_count: tasks.length,
          completed_item_count: completedCount,
          open_item_count: tasks.filter((task) => task.status === "pending")
            .length,
          last_updated: updatedAt,
        },
      };
    },
  });
}

/**
 * Common private-agent creation seam for Calendar today and other agents
 * later. Call this only after the originating action succeeded.
 */
export async function createTodo(
  input: CreateTodoInput,
  persistence: TodoWriteParams,
): Promise<{ task: TodoItem; result: PkmWriteCoordinatorResult }> {
  const task = buildTodo(input);
  const result = await write(
    persistence,
    task.type === "automatic"
      ? "one_todo_list_calendar_booking"
      : "one_todo_list_owner_confirmed_add",
    `one_todo_list:create:${task.id}`,
    (current) => {
      const existingIndex = current.tasks.findIndex(
        (item) => item.id === task.id,
      );
      if (existingIndex < 0) return [task, ...current.tasks];
      const existing = current.tasks[existingIndex]!;
      // Calendar retries are idempotent and must not revive an item the owner
      // already completed or removed.
      const updated = {
        ...task,
        status: existing.status,
        completedAt: existing.completedAt,
        deletedAt: existing.deletedAt,
        createdAt: existing.createdAt,
      };
      return current.tasks.map((item) =>
        item.id === task.id ? updated : item,
      );
    },
  );
  return { task, result };
}

export const TodoListPkmService = {
  async load(params: TodoWriteParams): Promise<TodoListState> {
    const domainData = await PersonalKnowledgeModelService.loadDomainData({
      userId: params.userId,
      domain: TODO_LIST_PKM_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch(() => null);
    return readTodoListState(domainData);
  },

  create: createTodo,

  update(
    params: TodoWriteParams & {
      taskId: string;
      update: Partial<MutableTodoFields>;
    },
  ) {
    const updatedAt = new Date().toISOString();
    return write(
      params,
      "one_todo_list_owner_confirmed_update",
      `one_todo_list:update:${params.taskId}:${updatedAt}`,
      (current) =>
        current.tasks.map((task) =>
          task.id === params.taskId
            ? {
                ...task,
                ...(params.update.title === undefined
                  ? {}
                  : { title: text(params.update.title, 240) || task.title }),
                ...(params.update.date === undefined
                  ? {}
                  : { date: normalizeDate(params.update.date) }),
                ...(params.update.time === undefined
                  ? {}
                  : { time: normalizeTime(params.update.time) }),
                ...(params.update.notes === undefined
                  ? {}
                  : { notes: text(params.update.notes, 1_200) || null }),
                updatedAt,
              }
            : task,
        ),
    );
  },

  setStatus(
    params: TodoWriteParams & {
      task: TodoItem;
      status: Exclude<TodoStatus, "deleted">;
    },
  ) {
    const updatedAt = new Date().toISOString();
    return write(
      params,
      "one_todo_list_owner_confirmed_status",
      `one_todo_list:status:${params.task.id}:${params.status}:${updatedAt}`,
      (current) => {
        const next = {
          ...params.task,
          status: params.status,
          completedAt: params.status === "done" ? updatedAt : null,
          deletedAt: null,
          updatedAt,
        };
        const found = current.tasks.some((task) => task.id === params.task.id);
        return found
          ? current.tasks.map((task) =>
              task.id === params.task.id ? next : task,
            )
          : [next, ...current.tasks];
      },
    );
  },

  remove(params: TodoWriteParams & { task: TodoItem }) {
    const updatedAt = new Date().toISOString();
    return write(
      params,
      "one_todo_list_owner_confirmed_remove",
      `one_todo_list:remove:${params.task.id}:${updatedAt}`,
      (current) => {
        const found = current.tasks.some((task) => task.id === params.task.id);
        if (!found && params.task.type === "automatic") {
          return [
            {
              ...params.task,
              status: "deleted" as const,
              deletedAt: updatedAt,
              updatedAt,
            },
            ...current.tasks,
          ];
        }
        return current.tasks.flatMap((task) => {
          if (task.id !== params.task.id) return [task];
          // A provider-backed automatic row needs a private tombstone or it
          // would reappear on the next Calendar refresh. A manual task can be
          // removed entirely.
          return task.type === "automatic"
            ? [
                {
                  ...task,
                  status: "deleted" as const,
                  deletedAt: updatedAt,
                  updatedAt,
                },
              ]
            : [];
        });
      },
    );
  },
};

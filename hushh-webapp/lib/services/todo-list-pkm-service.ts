"use client";

/** Vault-bearing persistence; record construction remains import-safe. */
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator, type PkmWriteCoordinatorResult } from "@/lib/services/pkm-write-coordinator";
import { todoReminderProjection } from "@/lib/todos/reminder-schedule";
import { changedTodoFields, type TodoItem, type TodoStatus, type TodoEditableFields } from "@/lib/todos/todo-list-model";
import { buildTodo, readTodoListState, normalizeEdits, privateTodoData, type CreateTodoInput, type TodoListState } from "@/lib/todos/todo-record";
export { TODO_SOURCE_LABELS, openTodoItems, completedTodoItems } from "@/lib/todos/todo-list-model";
export type { TodoType, TodoStatus, TodoSourceAgent, TodoItem } from "@/lib/todos/todo-list-model";
export { buildTodo, calendarTodoInput, gmailTodoInput, agentTodoInput, isLiveAgentTodo, readTodoListState } from "@/lib/todos/todo-record";
export type { AgentTodo, CreateTodoInput, CalendarTodoEvent, GmailTodoEvent, TodoListState } from "@/lib/todos/todo-record";
export const TODO_LIST_PKM_DOMAIN = "one_todos" as const;

export type TodoWriteParams = {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
};

type MutableTodoFields = TodoEditableFields;

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
      tasks,
      updatedAt,
    },
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
    build: async (context) => {
      const currentDomain = (context.currentDomainData ?? {}) as Record<
        string,
        unknown
      >;
      const state = readTodoListState(currentDomain);
      const updatedAt = new Date().toISOString();
      const tasks = update(state).map((task) => {
        const previous = state.tasks.find((item) => item.id === task.id);
        if (previous && JSON.stringify(previous) === JSON.stringify(task))
          return task;
        return { ...task, revision: (previous?.revision ?? 0) + 1 };
      });
      const completedCount = tasks.filter(
        (task) => task.status === "done",
      ).length;

      return {
        domainData: privateDomainData(currentDomain, tasks, updatedAt),
        writeProjections: [await todoReminderProjection(params.userId, tasks)],
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
    task.sourceAgent === "calendar" && task.type === "automatic"
      ? "one_todo_list_calendar_booking"
      : task.sourceAgent === "gmail" && task.type === "automatic"
        ? "one_todo_list_gmail_follow_up"
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
        ...existing.ownerOverrides,
        status: existing.status,
        completedAt: existing.completedAt,
        deletedAt: existing.deletedAt,
        createdAt: existing.createdAt,
        ownerOverrides: existing.ownerOverrides,
        reminderAt: Object.hasOwn(existing, "reminderAt") ? existing.reminderAt : task.reminderAt,
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
    });
    return readTodoListState(domainData);
  },

  create: createTodo,

  update(
    params: TodoWriteParams & {
      taskId: string;
      task?: TodoItem;
      update: Partial<MutableTodoFields>;
    },
  ) {
    const updatedAt = new Date().toISOString();
    return write(
      params,
      "one_todo_list_owner_confirmed_update",
      `one_todo_list:update:${params.taskId}:${updatedAt}`,
      (current) => {
        const saved = current.tasks.find(task => task.id === params.taskId);
        const rendered = params.task?.type === "automatic" && params.task.id === params.taskId ? params.task : null;
        const task = rendered?.sourceVersion && rendered.sourceVersion !== saved?.sourceVersion ? rendered : saved ?? rendered;
        if (!task || task.status === "deleted") throw new Error("This item is no longer available.");
        if (saved && params.task && (saved.revision ?? 0) !== (params.task.revision ?? 0)) {
          throw new Error("This item changed on another device. Refresh before editing it.");
        }
        const edits = normalizeEdits(changedTodoFields(params.task ?? task, params.update));
        if ((edits.date !== undefined || edits.time !== undefined) && params.update.reminderAt === undefined) edits.reminderAt = null;
        if (edits.title !== undefined && !edits.title) throw new Error("Enter a title.");
        const updated = { ...task, ...edits, updatedAt,
          ...(task.type === "automatic" ? { ownerOverrides: { ...task.ownerOverrides, ...edits } } : {}) };
        return saved ? current.tasks.map(item => item.id === task.id ? updated : item) : [updated, ...current.tasks];
      },
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
        const stored = current.tasks.find((task) => task.id === params.task.id);
        const latest =
          (params.task.sourceVersion && params.task.sourceVersion !== stored?.sourceVersion ? params.task : stored) ??
          (params.task.type === "automatic" ? params.task : null);
        if (!latest || latest.status === "deleted") return current.tasks;
        const next = {
          ...latest,
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
          // would reappear on the next Calendar refresh. Manual rows retain
          // the same deletion receipt for memory freshness.
          return [
            {
              ...task,
              ...(params.task.sourceVersion ? { sourceVersion: params.task.sourceVersion, context: params.task.context } : {}),
              status: "deleted" as const,
              deletedAt: updatedAt,
              updatedAt,
            },
          ];
        });
      },
    );
  },
};

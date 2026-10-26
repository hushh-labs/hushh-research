/** Import-safe task records, provider projections and legacy decoding. */
import { normalizeInternalRouteHref } from "@/lib/navigation/routes";
import { TODO_SOURCE_LABELS, type TodoType, type TodoStatus, type TodoSourceAgent, type TodoItem, type TodoEditableFields } from "./todo-list-model";

/** Explicit follow-up metadata supplied by a live agent/domain publisher. */
export type AgentTodo = {
  /** A publisher may distinguish a new run or a newly required follow-up. */
  key?: string;
  source: Exclude<TodoSourceAgent, null>;
  title: string;
  href: string;
  context?: string;
  /** A shared account prerequisite, explicitly identified by its publisher. */
  groupKey?: string;
  sourceVersion?: string;
  date?: string | null;
  time?: string | null;
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
  reminderAt?: string | null;
  context?: string | null;
  sourceVersion?: string;
};

export type CalendarTodoEvent = {
  id?: string | null;
  title?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  conference_url?: string | null;
  conferenceUrl?: string | null;
  context?: string | null;
};

export type GmailTodoEvent = {
  id?: string | null;
  title?: string | null;
};

export type TodoListState = {
  tasks: TodoItem[];
};

type PrivateTodoData = {
  tasks?: unknown;
  updatedAt?: unknown;
};

type MutableTodoFields = TodoEditableFields;

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function normalizeReminder(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function normalizeEdits(value: Partial<MutableTodoFields>): Partial<MutableTodoFields> {
  return {
    ...(value.title === undefined ? {} : { title: text(value.title, 240) }),
    ...(value.date === undefined ? {} : { date: normalizeDate(value.date) }),
    ...(value.time === undefined ? {} : { time: normalizeTime(value.time) }),
    ...(value.notes === undefined ? {} : { notes: text(value.notes, 1_200) || null }),
    ...(value.reminderAt === undefined ? {} : { reminderAt: normalizeReminder(value.reminderAt) }),
  };
}

function normalizeTime(value: unknown): string | null {
  const time = text(value, 5);
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null;
}

function hasInternalTaskLink(id: string, sourceId: string | null): boolean {
  return Boolean(sourceId) && (
    (id.startsWith("feed_") && sourceId!.startsWith("feed:")) ||
    /^suggested_[a-f0-9]{64}$/.test(id)
  );
}

function normalizeLink(value: unknown, allowInternal = false): string | null {
  const candidate = text(value, 1_500);
  if (!candidate) return null;
  const internal = allowInternal ? normalizeInternalRouteHref(candidate) : null;
  if (internal) return internal;
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
  if (typeof value === "string" && Object.hasOwn(TODO_SOURCE_LABELS, value)) {
    return value as Exclude<TodoSourceAgent, null>;
  }
  // Original automatic records omitted their Calendar source. Keep that
  // compatibility without mislabelling an unknown, explicitly named agent.
  return type === "automatic" ? (value ? "agent" : "calendar") : null;
}

export function privateTodoData(
  domainData: Record<string, unknown> | null | undefined,
): PrivateTodoData {
  const candidate = domainData?._private;
  return isRecord(candidate) ? candidate : {};
}

function normalizeItem(value: unknown): TodoItem | null {
  if (!isRecord(value)) return null;
  const id = text(value.id, 240);
  const title = String(value.title ?? "");
  const createdAt = text(value.createdAt, 64);
  const updatedAt = text(value.updatedAt, 64);
  if (!id || !title || !createdAt || !updatedAt) return null;

  const completedAt = text(value.completedAt, 64) || null;
  const deletedAt = text(value.deletedAt, 64) || null;
  const type = normalizeType(value.type);
  const sourceId = text(value.sourceId ?? value.calendarEventId, 240) || null;

  return {
    id,
    title,
    type,
    date: normalizeDate(value.date ?? value.dueOn),
    time: normalizeTime(value.time),
    status: normalizeStatus(value.status, completedAt, deletedAt),
    sourceAgent: normalizeSource(value.sourceAgent ?? value.source, type),
    sourceId,
    link: normalizeLink(
      value.link,
      hasInternalTaskLink(id, sourceId),
    ),
    notes: value.notes ? String(value.notes) : null,
    ...(Object.hasOwn(value, "context") ? { context: text(value.context, 1_200) || null } : {}),
    ...(typeof value.sourceVersion === "string" ? { sourceVersion: value.sourceVersion } : {}),
    revision:
      Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
        ? Number(value.revision)
        : 0,
    createdAt,
    updatedAt,
    completedAt,
    deletedAt,
    ...(Object.hasOwn(value, "reminderAt") ? { reminderAt: normalizeReminder(value.reminderAt) } : {}),
    ...(isRecord(value.ownerOverrides)
      ? { ownerOverrides: normalizeEdits(value.ownerOverrides) } : {}),
  };
}

function nowTodoId(): string {
  return `todo_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function automaticTodoId(
  source: Exclude<TodoSourceAgent, null>,
  sourceId: string,
): string {
  return `${source}_${sourceId}`.slice(0, 240);
}

/** Build a normalized task before it enters the encrypted write coordinator. */
export function buildTodo(
  input: CreateTodoInput,
  now = new Date().toISOString(),
): TodoItem {
  const type = input.type === "automatic" ? "automatic" : "manual";
  const sourceId = text(input.sourceId, 240) || null;
  const source = normalizeSource(input.source, type);
  const id =
    text(input.id, 240) ||
    (type === "automatic" && sourceId && source
      ? automaticTodoId(source, sourceId)
      : nowTodoId());

  return {
    id,
    title: text(input.title, 240),
    type,
    date: normalizeDate(input.date),
    time: normalizeTime(input.time),
    status: "pending",
    sourceAgent: source,
    sourceId,
    link: normalizeLink(
      input.link,
      hasInternalTaskLink(id, sourceId),
    ),
    notes: text(input.notes, 1_200) || null,
    ...(input.context ? { context: text(input.context, 1_200) } : {}),
    ...(input.sourceVersion ? { sourceVersion: input.sourceVersion } : {}),
    reminderAt: normalizeReminder(input.reminderAt),
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
      id: automaticTodoId("calendar", sourceId),
      title,
      type: "automatic",
      date: allDayDate,
      time: null,
      source: "calendar",
      sourceId,
      link,
      context: event.context,
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
    id: automaticTodoId("calendar", sourceId),
    title,
    type: "automatic",
    date,
    time,
    source: "calendar",
    sourceId,
    link,
    context: event.context,
  };
}

/**
 * Converts an owner-confirmed Gmail follow-up into the same encrypted task
 * record. Gmail message identifiers never enter the browser or this record;
 * the server supplies a short-lived opaque proposal item id instead.
 */
export function gmailTodoInput(event: GmailTodoEvent): CreateTodoInput | null {
  const sourceId = text(event.id, 240);
  const title = text(event.title, 240);
  if (!sourceId || !title) return null;
  return {
    id: automaticTodoId("gmail", sourceId),
    title,
    type: "automatic",
    source: "gmail",
    sourceId,
  };
}

/** Live Feed tasks are projections; only owner completion/dismissal is saved. */
export function agentTodoInput(
  id: string,
  item: AgentTodo,
): CreateTodoInput | null {
  if (typeof id !== "string" || !item || typeof item.title !== "string")
    return null;
  const sourceId = typeof item.key === "string" ? item.key.trim() : id.trim();
  const title = text(item.title, 240);
  const link = normalizeInternalRouteHref(item.href);
  if (
    !sourceId ||
    sourceId.length > 220 ||
    !title ||
    !link ||
    !Object.hasOwn(TODO_SOURCE_LABELS, item.source)
  )
    return null;
  return {
    id: `feed_${sourceId}`,
    sourceId: `feed:${sourceId}`,
    title,
    type: "automatic",
    source: item.source,
    link,
    context: item.context,
    sourceVersion: item.sourceVersion,
    date: item.date,
    time: item.time,
  };
}

export function isLiveAgentTodo(task: TodoItem): boolean {
  return (
    task.id.startsWith("feed_") && Boolean(task.sourceId?.startsWith("feed:"))
  );
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
    tasks: tasks.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    ),
  };
}

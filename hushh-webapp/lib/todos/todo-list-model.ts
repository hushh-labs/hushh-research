/** Import-safe task values and projections. Persistence remains in the existing
 * encrypted PKM service; a renderer imports no authentication or native SDK. */

export type TodoType = "automatic" | "manual";
export type TodoStatus = "pending" | "done" | "deleted";
export const TODO_SOURCE_LABELS = {
  calendar: "Calendar",
  gmail: "Gmail",
  drive: "Drive",
  kai: "Finance",
  kyc: "KYC",
  location: "Location",
  connections: "Connections",
  consent: "Consent",
  agent: "Private agent",
  messages: "Messages",
  wallet: "Wallet",
  ria: "Advisor",
  pkm: "Memory",
} as const;
export type TodoSourceAgent = keyof typeof TODO_SOURCE_LABELS | null;

export type TodoEditableFields = {
  title: string;
  date: string | null;
  time: string | null;
  notes: string | null;
  reminderAt?: string | null;
};

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
  /** Verified source context, separate from the owner's editable notes. */
  context?: string | null;
  /** Exact, order-independent queue membership for a grouped prerequisite. */
  sourceVersion?: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  revision?: number;
  /** An absolute instant, chosen in the editor's local time zone. */
  reminderAt?: string | null;
  /** Owner edits affect this task, while the provider retains its own record. */
  ownerOverrides?: Partial<TodoEditableFields>;
};

export function applyTodoOwnerOverrides(task: TodoItem, saved?: TodoItem): TodoItem {
  return saved ? { ...task, ...saved.ownerOverrides, ownerOverrides: saved.ownerOverrides,
    reminderAt: saved.reminderAt ?? null, revision: saved.revision,
    createdAt: saved.createdAt, updatedAt: saved.updatedAt } : task;
}

export function changedTodoFields(task: TodoItem, fields: Partial<TodoEditableFields>): Partial<TodoEditableFields> {
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
    value !== undefined && value !== task[key as keyof TodoEditableFields]));
}

/** Active rows are pending tasks. Completed and dismissed rows stay private. */
export function openTodoItems(tasks: TodoItem[]): TodoItem[] {
  return tasks.filter((task) => task.status === "pending");
}

export function completedTodoItems(tasks: TodoItem[]): TodoItem[] {
  return tasks.filter((task) => task.status === "done");
}

export function taskSort(left: TodoItem, right: TodoItem): number {
  const date = (left.date ?? "9999-12-31").localeCompare(
    right.date ?? "9999-12-31",
  );
  if (date !== 0) return date;
  const time = (left.time ?? "99:99").localeCompare(right.time ?? "99:99");
  if (time !== 0) return time;
  return left.title.localeCompare(right.title);
}

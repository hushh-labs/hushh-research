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
} as const;
export type TodoSourceAgent = keyof typeof TODO_SOURCE_LABELS | null;

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
  revision?: number;
};

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

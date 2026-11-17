/** Durable owner goals. Saving a plan conveys no execution authority. */
export type GoalStatus = "active" | "completed" | "archived" | "deleted";

export type Goal = {
  id: string;
  title: string;
  outcome: string;
  category: string | null;
  status: GoalStatus;
  /** Ordered references to saved tasks; task state remains owned by Tasks. */
  taskIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
};

export type GoalInput = Pick<Goal, "title" | "outcome"> & {
  category?: string | null;
};

export class GoalContractError extends Error {
  constructor(
    public readonly code:
      | "invalid_goal"
      | "unsupported_goals"
      | "goal_conflict"
      | "task_unavailable"
      | "confirmation_required",
  ) {
    super(code);
    this.name = "GoalContractError";
  }
}

export function isGoalRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new GoalContractError("invalid_goal");
  }
  return value;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

export function goalInput(input: GoalInput): Pick<Goal, "title" | "outcome" | "category"> {
  return {
    title: requiredText(input.title, 240).trim(),
    outcome: requiredText(input.outcome, 4_000).trim(),
    category: input.category == null ? null : requiredText(input.category, 80).trim(),
  };
}

/** Reject unreadable versions/records instead of dropping them on the next save. */
export function readGoals(domain: Record<string, unknown> | null | undefined): Goal[] {
  const privateData = domain?._private;
  if (privateData === undefined) return [];
  if (!isGoalRecord(privateData)) throw new GoalContractError("unsupported_goals");
  const envelope = privateData.goals;
  if (envelope === undefined) return [];
  if (!isGoalRecord(envelope) || envelope.schemaVersion !== 1 || !Array.isArray(envelope.items)) {
    throw new GoalContractError("unsupported_goals");
  }
  const ids = new Set<string>();
  return envelope.items.map((item: unknown) => {
    if (!isGoalRecord(item)) throw new GoalContractError("invalid_goal");
    const id = requiredText(item.id, 240);
    requiredText(item.title, 240);
    requiredText(item.outcome, 4_000);
    if (item.category !== null) requiredText(item.category, 80);
    if (ids.has(id) || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1 ||
      typeof item.status !== "string" || !["active", "completed", "archived", "deleted"].includes(item.status) ||
      !timestamp(item.createdAt) || !timestamp(item.updatedAt) ||
      !(item.completedAt === null || timestamp(item.completedAt)) ||
      !(item.deletedAt === null || timestamp(item.deletedAt)) ||
      (item.status === "completed") !== (item.completedAt !== null) ||
      (item.status === "deleted") !== (item.deletedAt !== null) ||
      !Array.isArray(item.taskIds)) {
      throw new GoalContractError("invalid_goal");
    }
    ids.add(id);
    const taskIds = item.taskIds.map((taskId: unknown) => requiredText(taskId, 240));
    if (new Set(taskIds).size !== taskIds.length) throw new GoalContractError("invalid_goal");
    // Retain extension fields from compatible writers; never rewrite task rows.
    return { ...item, taskIds } as Goal;
  });
}

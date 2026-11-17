"use client";

import {
  GoalContractError,
  goalInput,
  isGoalRecord,
  readGoals,
  type Goal,
  type GoalInput,
  type GoalStatus,
} from "@/lib/goals/goal-model";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import {
  TODO_LIST_PKM_DOMAIN,
  readTodoListState,
  type TodoWriteParams,
} from "@/lib/services/todo-list-pkm-service";

type GoalWriteParams = TodoWriteParams & { confirmedByUser: true };
type GoalEditParams = GoalWriteParams & { goalId: string; expectedRevision: number };

/** Existing task writers preserve this sibling, unlike new fields on task rows. */
function writeGoals(
  params: GoalWriteParams,
  operationId: string,
  mutate: (goals: Goal[], domain: Record<string, unknown>, now: string) => Goal[],
) {
  if (params.confirmedByUser !== true) throw new GoalContractError("confirmation_required");
  const now = new Date().toISOString();
  return PkmWriteCoordinator.saveMergedDomain({
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    domain: TODO_LIST_PKM_DOMAIN,
    confirmation: { confirmedByUser: true, surface: "web", source: "one_goals_owner_confirmed" },
    idempotencyScope: `one_goals:${operationId}`,
    build: ({ currentDomainData }) => {
      const goals = readGoals(currentDomainData);
      const next = mutate(goals, currentDomainData, now);
      const privateData = isGoalRecord(currentDomainData._private) ? currentDomainData._private : {};
      const envelope = isGoalRecord(privateData.goals) ? privateData.goals : {};
      const tasks = readTodoListState(currentDomainData).tasks;
      return {
        unchanged: next === goals,
        domainData: {
          ...currentDomainData,
          _private: {
            ...privateData,
            goals: { ...envelope, schemaVersion: 1, items: next },
          },
        },
        // Match the existing task metadata contract. Goal details and links
        // stay encrypted; task counters are not evidence of goal completion.
        summary: {
          item_count: tasks.length,
          completed_item_count: tasks.filter((task) => task.status === "done").length,
          open_item_count: tasks.filter((task) => task.status === "pending").length,
          last_updated: now,
        },
      };
    },
  });
}

function editGoal(
  params: GoalEditParams,
  update: (goal: Goal, domain: Record<string, unknown>, now: string) => Goal,
) {
  const { goalId, expectedRevision } = params;
  const operationId = crypto.randomUUID();
  return writeGoals(params, operationId, (goals, domain, now) => {
    const current = goals.find((goal) => goal.id === goalId);
    if (!current || current.status === "deleted" ||
      !Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision) {
      throw new GoalContractError("goal_conflict");
    }
    const next = update(current, domain, now);
    if (next === current) return goals;
    return goals.map((goal) => goal.id === current.id
      ? { ...next, revision: current.revision + 1, updatedAt: now }
      : goal);
  });
}

/** Owner-confirmed planning only. Scheduling uses its own qualified authority. */
export const GoalsPkmService = {
  async load(params: TodoWriteParams): Promise<{ goals: Goal[] }> {
    const domain = await PersonalKnowledgeModelService.loadDomainData({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      domain: TODO_LIST_PKM_DOMAIN,
    });
    return { goals: readGoals(domain) };
  },

  async create(input: GoalInput, params: GoalWriteParams) {
    const fields = goalInput(input);
    const goalId = `goal_${crypto.randomUUID()}`;
    const result = await writeGoals(params, `create:${goalId}`, (goals, _domain, now) => {
      // The stable identity is allocated before the coordinator's CAS retries.
      if (goals.some((goal) => goal.id === goalId)) return goals;
      return [...goals, {
        ...fields, id: goalId, status: "active", taskIds: [], revision: 1,
        createdAt: now, updatedAt: now, completedAt: null, deletedAt: null,
      }];
    });
    return { goalId, result };
  },

  update(params: GoalEditParams & { update: GoalInput }) {
    const fields = goalInput(params.update);
    const replaceCategory = params.update.category !== undefined;
    return editGoal(params, (goal) => ({
      ...goal, ...fields, category: replaceCategory ? fields.category : goal.category,
    }));
  },

  setStatus(params: GoalEditParams & { status: GoalStatus }) {
    const { status } = params;
    if (!["active", "completed", "archived", "deleted"].includes(status)) {
      throw new GoalContractError("invalid_goal");
    }
    return editGoal(params, (goal, _domain, now) => goal.status === status ? goal : ({
      ...goal,
      status,
      completedAt: status === "completed" ? now : null,
      deletedAt: status === "deleted" ? now : null,
    }));
  },

  setTaskLinks(params: GoalEditParams & { taskIds: string[] }) {
    // Validate against the latest saved task snapshot on every conflict retry.
    const taskIds = [...params.taskIds];
    if (taskIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 240) ||
      new Set(taskIds).size !== taskIds.length) throw new GoalContractError("invalid_goal");
    return editGoal(params, (goal, domain) => {
      const tasks = readTodoListState(domain).tasks;
      if (taskIds.some((id) => !tasks.some((task) => task.id === id && task.status !== "deleted"))) {
        throw new GoalContractError("task_unavailable");
      }
      return JSON.stringify(goal.taskIds) === JSON.stringify(taskIds) ? goal : { ...goal, taskIds };
    });
  },
};

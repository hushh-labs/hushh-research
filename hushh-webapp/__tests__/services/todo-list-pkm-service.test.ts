import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { loadDomainData: vi.fn() },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: vi.fn() },
}));

import {
  TODO_LIST_PKM_DOMAIN,
  TodoListPkmService,
  openTodoItems,
  readTodoListState,
  type TodoItem,
} from "@/lib/services/todo-list-pkm-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

const write = {
  userId: "owner-1",
  vaultKey: "vault-key",
  vaultOwnerToken: "owner-token",
};

const task: TodoItem = {
  id: "todo_1",
  title: "Walk after lunch",
  category: "fitness",
  cadence: "daily",
  dueOn: "2026-10-07",
  completedAt: null,
  createdAt: "2026-10-07T08:00:00.000Z",
  updatedAt: "2026-10-07T08:00:00.000Z",
};

describe("TodoListPkmService", () => {
  it("reads only valid owner-added items from the private branch", () => {
    expect(readTodoListState({
      tasks: [{ ...task, title: "Wrong branch" }],
      _private: {
        tasks: [task, { id: "broken", title: "", createdAt: "now", updatedAt: "now" }],
      },
    })).toEqual({ tasks: [task] });
  });

  it("keeps completed items in encrypted history but removes them from the active list", () => {
    const completed = { ...task, id: "todo_completed", completedAt: "2026-10-07T09:00:00.000Z" };

    expect(openTodoItems([task, completed])).toEqual([task]);
  });

  it("writes owner-confirmed items to a private dynamic domain", async () => {
    const save = vi.mocked(PkmWriteCoordinator.saveMergedDomain);
    let captured: Parameters<typeof PkmWriteCoordinator.saveMergedDomain>[0] | null = null;
    save.mockImplementation(async (params) => {
      captured = params;
      return { success: true, saveState: "saved", fullBlob: {} };
    });

    await TodoListPkmService.add({ ...write, task });

    expect(captured?.domain).toBe(TODO_LIST_PKM_DOMAIN);
    expect(captured?.confirmation).toMatchObject({
      confirmedByUser: true,
      source: "one_todo_list_owner_confirmed_add",
    });
    const plan = await captured!.build({
      currentDomainData: { public_note: "leave untouched" },
      currentManifest: null,
      currentEncryptedDomain: null,
      baseFullBlob: {},
      attempt: 0,
      upgradedInSession: false,
    });
    expect(plan.domainData).toMatchObject({
      public_note: "leave untouched",
      _private: { tasks: [task] },
    });
    expect(plan.summary).toMatchObject({
      item_count: 1,
      open_item_count: 1,
      completed_item_count: 0,
    });
  });

  it("persists completion in the private dynamic domain before the item leaves the active list", async () => {
    const save = vi.mocked(PkmWriteCoordinator.saveMergedDomain);
    let captured: Parameters<typeof PkmWriteCoordinator.saveMergedDomain>[0] | null = null;
    save.mockImplementation(async (params) => {
      captured = params;
      return { success: true, saveState: "saved", fullBlob: {} };
    });

    const completedAt = "2026-10-07T10:00:00.000Z";
    await TodoListPkmService.setCompletion({
      ...write,
      taskId: task.id,
      completedAt,
      updatedAt: completedAt,
    });

    expect(captured?.confirmation).toMatchObject({
      confirmedByUser: true,
      source: "one_todo_list_owner_confirmed_completion",
    });
    const plan = await captured!.build({
      currentDomainData: { _private: { tasks: [task] } },
      currentManifest: null,
      currentEncryptedDomain: null,
      baseFullBlob: {},
      attempt: 0,
      upgradedInSession: false,
    });
    expect(plan.domainData).toMatchObject({
      _private: {
        tasks: [{ ...task, completedAt, updatedAt: completedAt }],
      },
    });
    expect(plan.summary).toMatchObject({
      item_count: 1,
      open_item_count: 0,
      completed_item_count: 1,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { loadDomainData: vi.fn() },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: vi.fn() },
}));

import {
  TODO_LIST_PKM_DOMAIN,
  TodoListPkmService,
  buildTodo,
  calendarTodoInput,
  createTodo,
  gmailTodoInput,
  openTodoItems,
  readTodoListState,
  type TodoItem,
} from "@/lib/services/todo-list-pkm-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

const persistence = {
  userId: "owner-1",
  vaultKey: "vault-key",
  vaultOwnerToken: "owner-token",
};

const task: TodoItem = {
  id: "todo_1",
  title: "Walk after lunch",
  type: "manual",
  date: "2026-10-07",
  time: "13:00",
  status: "pending",
  sourceAgent: null,
  sourceId: null,
  link: null,
  notes: "A short walk",
  completedAt: null,
  deletedAt: null,
  createdAt: "2026-10-07T08:00:00.000Z",
  updatedAt: "2026-10-07T08:00:00.000Z",
};

const coordinatorContext = {
  currentManifest: null,
  currentEncryptedDomain: null,
  baseFullBlob: {},
  attempt: 0,
  upgradedInSession: false,
};

function mockSuccessfulWrite() {
  const save = vi.mocked(PkmWriteCoordinator.saveMergedDomain);
  save.mockImplementation(async () => ({
    success: true,
    saveState: "saved",
    fullBlob: {},
  }));
  return save;
}

describe("TodoListPkmService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads task details only from the private encrypted branch", () => {
    expect(
      readTodoListState({
        tasks: [{ ...task, title: "Wrong branch" }],
        _private: {
          tasks: [
            task,
            { id: "broken", title: "", createdAt: "now", updatedAt: "now" },
          ],
        },
      }),
    ).toEqual({ tasks: [task] });
  });

  it("creates a safe automatic input from a confirmed Calendar event", () => {
    expect(
      calendarTodoInput({
        id: "calendar-event-1",
        title: "Meet with Sarukhan",
        start: { date: "2026-10-08" },
        conference_url: "https://meet.google.com/abc-defg-hij",
      }),
    ).toMatchObject({
      id: "calendar_calendar-event-1",
      title: "Meet with Sarukhan",
      type: "automatic",
      date: "2026-10-08",
      time: null,
      source: "calendar",
      sourceId: "calendar-event-1",
      link: "https://meet.google.com/abc-defg-hij",
    });
  });

  it("creates an opaque Gmail follow-up without a provider message id", () => {
    expect(
      gmailTodoInput({
        id: "gmail_todo_opaque:1",
        title: "Follow up: Project plan",
      }),
    ).toEqual({
      id: "gmail_gmail_todo_opaque:1",
      title: "Follow up: Project plan",
      type: "automatic",
      source: "gmail",
      sourceId: "gmail_todo_opaque:1",
    });
  });

  it("writes owner-created task details under the encrypted private domain", async () => {
    const save = mockSuccessfulWrite();

    await createTodo({ ...task, type: "manual", source: null }, persistence);

    const captured = save.mock.calls[0]?.[0];
    expect(captured?.domain).toBe(TODO_LIST_PKM_DOMAIN);
    expect(captured?.confirmation).toMatchObject({
      confirmedByUser: true,
      source: "one_todo_list_owner_confirmed_add",
    });
    const plan = await captured!.build({
      currentDomainData: { public_note: "leave untouched" },
      ...coordinatorContext,
    });
    expect(plan.domainData).toMatchObject({
      public_note: "leave untouched",
      _private: {
        tasks: [expect.objectContaining({ id: task.id, title: task.title })],
      },
    });
    expect(plan.summary).toMatchObject({
      item_count: 1,
      open_item_count: 1,
      completed_item_count: 0,
    });
  });

  it("persists completion before an item leaves the active list", async () => {
    const save = mockSuccessfulWrite();

    await TodoListPkmService.setStatus({
      ...persistence,
      task,
      status: "done",
    });

    const captured = save.mock.calls[0]?.[0];
    expect(captured?.confirmation).toMatchObject({
      confirmedByUser: true,
      source: "one_todo_list_owner_confirmed_status",
    });
    const plan = await captured!.build({
      currentDomainData: { _private: { tasks: [task] } },
      ...coordinatorContext,
    });
    const stored = readTodoListState(plan.domainData).tasks;
    expect(stored[0]).toMatchObject({ id: task.id, status: "done" });
    expect(stored[0]?.completedAt).toEqual(expect.any(String));
    expect(openTodoItems(stored)).toEqual([]);
  });

  it("keeps an encrypted tombstone when an automatic Calendar row is dismissed", async () => {
    const save = mockSuccessfulWrite();
    const automatic = buildTodo(
      {
        id: "calendar_event-1",
        title: "Meet with Sarukhan",
        type: "automatic",
        source: "calendar",
        sourceId: "event-1",
        date: "2026-10-08",
        time: "20:30",
      },
      "2026-10-07T08:00:00.000Z",
    );

    await TodoListPkmService.remove({ ...persistence, task: automatic });

    const captured = save.mock.calls[0]?.[0];
    const plan = await captured!.build({
      currentDomainData: { _private: { tasks: [] } },
      ...coordinatorContext,
    });
    expect(readTodoListState(plan.domainData).tasks).toEqual([
      expect.objectContaining({ id: automatic.id, status: "deleted" }),
    ]);
  });
});

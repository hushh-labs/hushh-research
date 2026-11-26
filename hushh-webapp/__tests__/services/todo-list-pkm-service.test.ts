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
  TODO_SOURCE_LABELS,
  agentTodoInput,
  buildTodo,
  calendarTodoInput,
  createTodo,
  gmailTodoInput,
  openTodoItems,
  readTodoListState,
  type TodoItem,
} from "@/lib/services/todo-list-pkm-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { GoalsPkmService } from "@/lib/services/goals-pkm-service";
import { readGoals, type Goal } from "@/lib/goals/goal-model";

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

const goal: Goal = {
  id: "goal_1", title: "Stay active", outcome: "Walk on three days this week",
  category: "Wellbeing", status: "active", taskIds: [], revision: 1,
  createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: null, deletedAt: null,
};
const goalPersistence = { ...persistence, confirmedByUser: true as const };
const goalEdit = { ...goalPersistence, goalId: goal.id, expectedRevision: 1 };
const goalDomain = (items: Goal[] = [goal], tasks: TodoItem[] = [task]) => ({
  public_note: "preserve",
  _private: { tasks, goals: { schemaVersion: 1, items }, other: { keep: true } },
});

describe("Goals sharing the encrypted task domain", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("loads private goals without interpreting a failed read as empty", async () => {
    const read = vi.mocked(PersonalKnowledgeModelService.loadDomainData);
    read.mockResolvedValueOnce(null).mockResolvedValueOnce(goalDomain());
    await expect(GoalsPkmService.load(persistence)).resolves.toEqual({ goals: [] });
    await expect(GoalsPkmService.load(persistence)).resolves.toEqual({ goals: [goal] });
    expect(readGoals({ goals: [goal] })).toEqual([]);
    read.mockRejectedValueOnce(new Error("unavailable"));
    await expect(GoalsPkmService.load(persistence)).rejects.toThrow("unavailable");
  });

  it("roundtrips goal links through existing task writes and preserves raw task records", async () => {
    const save = mockSuccessfulWrite();
    const rawTask = { ...task, futureField: { keep: "verbatim" } };
    const domain = goalDomain([goal], [rawTask]);
    await GoalsPkmService.setTaskLinks({ ...goalEdit, taskIds: [task.id] });
    const goalWrite = save.mock.calls[0]![0];
    const first = await goalWrite.build({ ...coordinatorContext, currentDomainData: domain });
    expect(first.domainData).toMatchObject({ public_note: "preserve", _private: { tasks: [rawTask], other: { keep: true } } });
    expect(readGoals(first.domainData)[0]).toMatchObject({ taskIds: [task.id], revision: 2 });
    expect(first.summary).toEqual({ item_count: 1, open_item_count: 1, completed_item_count: 0, last_updated: expect.any(String) });
    expect(goalWrite).toMatchObject({ domain: TODO_LIST_PKM_DOMAIN, userId: persistence.userId, vaultKey: persistence.vaultKey, vaultOwnerToken: persistence.vaultOwnerToken, confirmation: { confirmedByUser: true } });

    await TodoListPkmService.setStatus({ ...persistence, task, status: "done" });
    const second = await save.mock.calls[1]![0].build({ ...coordinatorContext, currentDomainData: first.domainData });
    expect(readGoals(second.domainData)).toEqual(readGoals(first.domainData));
    expect(readTodoListState(second.domainData).tasks[0]).toMatchObject({ status: "done" });
    // Completion belongs to the task; it cannot silently complete the goal.
    expect(readGoals(second.domainData)[0]?.status).toBe("active");
    await GoalsPkmService.update({ ...goalEdit, expectedRevision: 2, update: { title: "Updated goal", outcome: goal.outcome } });
    const third = await save.mock.calls[2]![0].build({ ...coordinatorContext, currentDomainData: second.domainData });
    expect((third.domainData._private as Record<string, unknown>).tasks).toEqual((second.domainData._private as Record<string, unknown>).tasks);
    expect(readGoals(third.domainData)[0]?.category).toBe(goal.category);
  });

  it("creates one unscheduled goal identity across retries without overwriting other goals", async () => {
    const save = mockSuccessfulWrite();
    const { goalId } = await GoalsPkmService.create({ title: "New outcome", outcome: "Reviewed criteria" }, goalPersistence);
    const build = save.mock.calls[0]![0].build;
    const first = await build({ ...coordinatorContext, currentDomainData: goalDomain() });
    const newer = { ...goal, title: "Concurrent owner edit", revision: 2 };
    const retried = await build({ ...coordinatorContext, attempt: 1, currentDomainData: goalDomain([newer]) });
    expect(readGoals(retried.domainData)).toEqual([newer, expect.objectContaining({ id: goalId, revision: 1, taskIds: [], status: "active" })]);
    expect(readGoals(first.domainData)[1]).toEqual(readGoals(retried.domainData)[1]);
    const replay = await build({ ...coordinatorContext, currentDomainData: retried.domainData });
    expect(replay.unchanged).toBe(true);
  });

  it("commits reviewed steps and their goal links together and does not recreate steps on replay", async () => {
    const save = mockSuccessfulWrite();
    const { goalId } = await GoalsPkmService.create({
      title: goal.title, outcome: goal.outcome, taskIds: [task.id], steps: ["Organize the approved file"],
    }, goalPersistence);
    const build = save.mock.calls[0]![0].build;
    const rawTask = { ...task, futureField: "preserve" };
    const first = await build({ ...coordinatorContext, currentDomainData: goalDomain([goal], [rawTask]) });
    const step = readTodoListState(first.domainData).tasks.find(item => item.title === "Organize the approved file");
    expect(step).toMatchObject({ type: "manual", status: "pending", revision: 1 });
    expect(readGoals(first.domainData).find(item => item.id === goalId)?.taskIds).toEqual([task.id, step?.id]);
    expect(first.domainData).toMatchObject({ _private: { tasks: [expect.any(Object), rawTask] } });
    expect(await build({ ...coordinatorContext, attempt: 1, currentDomainData: first.domainData }))
      .toMatchObject({ unchanged: true, domainData: first.domainData });
  });

  it("rejects stale edits and cannot revive deleted goals", async () => {
    const save = mockSuccessfulWrite();
    await GoalsPkmService.update({ ...goalEdit, update: { title: "Late edit", outcome: goal.outcome } });
    const build = save.mock.calls[0]![0].build;
    await build({ ...coordinatorContext, currentDomainData: goalDomain() });
    expect(() => build({ ...coordinatorContext, attempt: 1, currentDomainData: goalDomain([{ ...goal, revision: 2 }]) })).toThrow("goal_conflict");
    expect(() => build({ ...coordinatorContext, currentDomainData: goalDomain([{ ...goal, status: "deleted", deletedAt: goal.updatedAt }]) })).toThrow("goal_conflict");
    expect(() => build({ ...coordinatorContext, currentDomainData: goalDomain([]) })).toThrow("goal_conflict");
  });

  it("checks new plan links on the same revision as the rest of the edit", async () => {
    const save = mockSuccessfulWrite();
    const plan = { title: "Updated outcome", outcome: goal.outcome, taskIds: [task.id] };
    await GoalsPkmService.savePlan({ ...goalEdit, plan });
    const build = save.mock.calls[0]![0].build;
    const updated = await build({ ...coordinatorContext, currentDomainData: goalDomain() });
    expect(readGoals(updated.domainData)[0]).toMatchObject({ ...plan, revision: 2 });
    expect(() => build({ ...coordinatorContext, attempt: 1, currentDomainData: goalDomain([goal], []) }))
      .toThrow("task_unavailable");
  });

  it("allows a saved task to support multiple goals but refuses missing/deleted task links on retry", async () => {
    const save = mockSuccessfulWrite();
    const other = { ...goal, id: "goal_2", taskIds: [task.id] };
    await GoalsPkmService.setTaskLinks({ ...goalEdit, taskIds: [task.id] });
    const build = save.mock.calls[0]![0].build;
    const linked = await build({ ...coordinatorContext, currentDomainData: goalDomain([goal, other]) });
    expect(readGoals(linked.domainData).map((row) => row.taskIds)).toEqual([[task.id], [task.id]]);
    for (const tasks of [[], [{ ...task, status: "deleted" as const, deletedAt: task.updatedAt }]]) {
      expect(() => build({ ...coordinatorContext, attempt: 1, currentDomainData: goalDomain([goal, other], tasks) })).toThrow("task_unavailable");
    }
    expect(() => GoalsPkmService.setTaskLinks({ ...goalEdit, taskIds: [task.id, task.id] })).toThrow("invalid_goal");
  });

  it("retains deletion receipts and removes links without mutating task state", async () => {
    const save = mockSuccessfulWrite();
    await GoalsPkmService.setTaskLinks({ ...goalEdit, taskIds: [] });
    const unlinked = await save.mock.calls[0]![0].build({ ...coordinatorContext, currentDomainData: goalDomain([{ ...goal, taskIds: [task.id] }], []) });
    expect(readGoals(unlinked.domainData)[0]).toMatchObject({ taskIds: [], revision: 2 });
    await GoalsPkmService.setStatus({ ...goalEdit, status: "completed" });
    const completed = await save.mock.calls[1]![0].build({ ...coordinatorContext, currentDomainData: goalDomain() });
    expect(readGoals(completed.domainData)[0]).toMatchObject({ status: "completed", completedAt: expect.any(String), revision: 2 });
    await GoalsPkmService.setStatus({ ...goalEdit, expectedRevision: 2, status: "deleted" });
    const deleted = await save.mock.calls[2]![0].build({ ...coordinatorContext, currentDomainData: completed.domainData });
    expect(readGoals(deleted.domainData)[0]).toMatchObject({ status: "deleted", deletedAt: expect.any(String), revision: 3 });
    expect((deleted.domainData._private as Record<string, unknown>).tasks).toEqual([task]);
  });

  it("blocks unsupported or malformed saved goals rather than erasing them", async () => {
    const save = mockSuccessfulWrite();
    await GoalsPkmService.create({ title: goal.title, outcome: goal.outcome }, goalPersistence);
    const build = save.mock.calls[0]![0].build;
    for (const envelope of [{ schemaVersion: 2, items: [goal] }, { schemaVersion: 1, items: [goal, goal] }, { schemaVersion: 1, items: [{ ...goal, revision: -1 }] }, { schemaVersion: 1, items: [{ ...goal, status: ["active"] }] }]) {
      expect(() => build({ ...coordinatorContext, currentDomainData: { _private: { goals: envelope } } })).toThrow();
    }
    const extended = { ...goal, futureField: "retain" };
    const saved = await build({ ...coordinatorContext, currentDomainData: { _private: { goals: { schemaVersion: 1, futureEnvelope: "retain", items: [extended] } } } });
    expect(saved.domainData).toMatchObject({ _private: { goals: { futureEnvelope: "retain", items: [extended, expect.any(Object)] } } });
  });

  it("requires explicit confirmation before entering the protected write coordinator", async () => {
    const save = mockSuccessfulWrite();
    const unconfirmed = { ...goalEdit, confirmedByUser: false as unknown as true };
    expect(() => GoalsPkmService.setStatus({ ...unconfirmed, status: "completed" })).toThrow("confirmation_required");
    expect(save).not.toHaveBeenCalled();
  });
});

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
  it.each([
    ["2024-02-29", "2024-02-29"], ["2099-01-01", "2099-01-01"],
    [" 2026-11-20 ", "2026-11-20"], ["2026-02-31", null],
    ["2025-02-29", null], ["2026-04-31", null], ["2026-13-01", null],
    ["2026-01-00", null], ["0000-01-01", null], ["2026-11-20junk", null],
  ])("normalizes the saved calendar date %s without dropping its task", (date, expected) => {
    const state = readTodoListState({ _private: { tasks: [{ ...task, date, time: "99:99" }] } });
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]).toMatchObject({ id: task.id, title: task.title, date: expected, time: null });
  });

  it("changes only the selected task and preserves unknown saved fields and opaque records", async () => {
    const save = mockSuccessfulWrite();
    const changed = { ...task, futureField: { keep: "selected" } };
    const retained = { ...task, id: "todo_other", futureField: { keep: "unrelated" } };
    const opaque = { id: "future_record", schemaVersion: 8, payload: { keep: true } };
    await TodoListPkmService.setStatus({ ...persistence, task, status: "done" });
    const plan = await save.mock.calls[0]![0].build({ ...coordinatorContext,
      currentDomainData: { _private: { tasks: [changed, retained, opaque], selectedCapabilities: ["calendar"] } },
    });
    const records = (plan.domainData._private as Record<string, unknown>).tasks;
    expect(records).toContainEqual(retained);
    expect(records).toContainEqual(opaque);
    expect(records).toContainEqual(expect.objectContaining({ id: task.id, status: "done", futureField: changed.futureField }));
    expect(readTodoListState(plan.domainData).selectedCapabilities).toEqual(["calendar"]);
    expect(plan.summary.item_count).toBe(2);
    expect(() => save.mock.calls[0]![0].build({ ...coordinatorContext,
      currentDomainData: { _private: { tasks: { futureSchema: 8 } } },
    })).toThrow("unsupported_task_records");
    const duplicates = [
      { ...task, title: "Older", updatedAt: "2026-10-06T08:00:00.000Z", extension: "older" },
      { ...task, title: "Newer", updatedAt: "2026-10-08T08:00:00.000Z", extension: "newer" },
    ];
    expect(() => save.mock.calls[0]![0].build({ ...coordinatorContext,
      currentDomainData: { _private: { tasks: duplicates } },
    })).toThrow("ambiguous_task_identity");
    await TodoListPkmService.saveSourceChoices({ ...persistence, selectedCapabilities: [] });
    const choices = await save.mock.calls[1]![0].build({ ...coordinatorContext,
      currentDomainData: { _private: { tasks: duplicates } },
    });
    expect((choices.domainData._private as Record<string, unknown>).tasks).toEqual(duplicates);
    await createTodo({ id: opaque.id, title: "A new task" }, persistence);
    expect(() => save.mock.calls[2]![0].build({ ...coordinatorContext,
      currentDomainData: { _private: { tasks: [opaque] } },
    })).toThrow("unsupported_task_identity");
  });
  it("preserves source choices and goal links across shared encrypted task writes", async () => {
    const save = mockSuccessfulWrite();
    const retained = { ...task, id: "todo_unrelated", futureField: { keep: true } };
    await TodoListPkmService.saveSourceChoices({ ...persistence, selectedCapabilities: ["calendar"] });
    const choices = await save.mock.calls[0]![0].build({
      ...coordinatorContext, currentDomainData: goalDomain([goal], [task, retained]),
    });
    await GoalsPkmService.setTaskLinks({ ...goalEdit, taskIds: [task.id] });
    const linked = await save.mock.calls[1]![0].build({
      ...coordinatorContext, currentDomainData: choices.domainData,
    });
    await TodoListPkmService.setStatus({ ...persistence, task, status: "done" });
    const completed = await save.mock.calls[2]![0].build({
      ...coordinatorContext, currentDomainData: linked.domainData,
    });
    expect(readTodoListState(completed.domainData)).toMatchObject({ selectedCapabilities: ["calendar"] });
    expect(readGoals(completed.domainData)).toEqual(readGoals(linked.domainData));
    expect(readGoals(completed.domainData)[0]?.taskIds).toEqual([task.id]);
    expect((completed.domainData._private as Record<string, unknown>).tasks).toContainEqual(retained);
  });
  it("saves source choices only in encrypted private memory, preserves tasks and reloads all-off", async () => {
    const save = mockSuccessfulWrite();
    const retained = { ...task, ownerExtension: "preserve" };
    await TodoListPkmService.saveSourceChoices({ ...persistence, selectedCapabilities: [] });
    const plan = await save.mock.calls[0][0].build({ ...coordinatorContext,
      currentDomainData: { _private: { tasks: [retained], unrelated: "preserved" } },
    });
    expect(plan.domainData).toMatchObject({ _private: { selectedCapabilities: [], tasks: [task], unrelated: "preserved" } });
    expect(((plan.domainData as Record<string, unknown>)._private as Record<string, unknown>).tasks).toEqual([retained]);
    expect(plan.summary).not.toHaveProperty("selectedCapabilities");
    expect(readTodoListState(plan.domainData as Record<string, unknown>)).toMatchObject({ selectedCapabilities: [], tasks: [task] });
    expect(readTodoListState({ selectedCapabilities: ["gmail"], _private: { tasks: [task] } })).not.toHaveProperty("selectedCapabilities");
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats an absent domain as empty but preserves a failed read as an error", async () => {
    const read = vi.mocked(PersonalKnowledgeModelService.loadDomainData);
    read.mockResolvedValueOnce(null);
    await expect(TodoListPkmService.load(persistence)).resolves.toEqual({ tasks: [] });
    read.mockRejectedValueOnce(new Error("unavailable"));
    await expect(TodoListPkmService.load(persistence)).rejects.toThrow("unavailable");
  });

  it.each(Object.keys(TODO_SOURCE_LABELS))("retains %s attribution through encrypted-record normalization", (source) => {
    const input = agentTodoInput("review:fixture", { source: source as keyof typeof TODO_SOURCE_LABELS, title: "Review — مرحباً 📁", href: "/one/feed" });
    expect(input).not.toBeNull();
    const value = buildTodo(input!);
    expect(readTodoListState({ _private: { tasks: [value] } }).tasks[0]).toMatchObject({ sourceAgent: source, link: "/one/feed", date: null });
  });

  it("rejects malformed task metadata and unsafe navigation instead of inventing a task", () => {
    for (const href of ["//evil.example/one", "/\\evil.example", "javascript:alert(1)", "https://outside.example", "/one/../login"]) {
      expect(agentTodoInput("fixture", { source: "drive", title: "Review", href })).toBeNull();
    }
    expect(agentTodoInput("", { source: "drive", title: "Review", href: "/one/feed" })).toBeNull();
    expect(agentTodoInput("fixture", { source: "drive", title: " ", href: "/one/feed" })).toBeNull();
    expect(agentTodoInput("fixture", { source: "__proto__" as "drive", title: "Review", href: "/one/feed" })).toBeNull();
    expect(buildTodo({ title: "Calendar item", type: "automatic", source: "calendar", sourceId: "event-1", link: "/logout" }).link).toBeNull();
    const unknown = { ...task, type: "automatic", sourceAgent: "future-agent" };
    expect(readTodoListState({ _private: { tasks: [unknown] } }).tasks[0]?.sourceAgent).toBe("agent");
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
    ).toEqual({ tasks: [{ ...task, revision: 0 }] });
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

  it("preserves reviewed suggestion links, deduplicates retries and does not claim a booking", async () => {
    const save = mockSuccessfulWrite();
    const input = { id: `suggested_${"a".repeat(64)}`, title: "Prepare meeting notes", type: "manual" as const, source: "calendar" as const, sourceId: "calendar-opaque", link: "/one/calendar" };
    const existing = buildTodo(input);
    expect(existing.link).toBe("/one/calendar");
    expect(readTodoListState({ _private: { tasks: [existing] } }).tasks[0]?.link).toBe("/one/calendar");
    await createTodo(input, persistence);
    const captured = save.mock.calls[0]![0];
    expect(captured.confirmation.source).toBe("one_todo_list_owner_confirmed_add");
    const plan = await captured.build({ ...coordinatorContext, currentDomainData: { _private: { tasks: [{ ...existing, status: "done", completedAt: "2026-10-22T00:00:00Z" }] } } });
    const stored = readTodoListState(plan.domainData).tasks;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: existing.id, status: "done", link: "/one/calendar" });
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
  it("persists completion for a provider projection not yet in encrypted tasks", async () => {
    const save = mockSuccessfulWrite();
    const automatic = buildTodo(
      {
        id: "calendar_existing-event",
        title: "Existing calendar event",
        type: "automatic",
        source: "calendar",
        sourceId: "existing-event",
      },
      task.createdAt,
    );
    await TodoListPkmService.setStatus({
      ...persistence,
      task: automatic,
      status: "done",
    });
    const plan = await save.mock.calls[0]![0].build({
      ...coordinatorContext,
      currentDomainData: { _private: { tasks: [] } },
    });
    const restored = readTodoListState(
      JSON.parse(JSON.stringify(plan.domainData)),
    ).tasks;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: automatic.id,
      sourceId: "existing-event",
      status: "done",
      createdAt: task.createdAt,
      revision: 1,
    });
    expect(restored[0]!.completedAt).toEqual(expect.any(String));
    expect(openTodoItems(restored)).toEqual([]);
  });
  it("stale completion cannot resurrect a deleted row", async () => {
    const save = mockSuccessfulWrite();
    const deleted = {
      ...task,
      status: "deleted" as const,
      deletedAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
      revision: 4,
    };
    await TodoListPkmService.setStatus({
      ...persistence,
      task,
      status: "done",
    });
    const plan = await save.mock.calls[0]![0].build({
      ...coordinatorContext,
      currentDomainData: { _private: { tasks: [deleted] } },
    });
    expect(readTodoListState(plan.domainData).tasks).toEqual([deleted]);
    expect(plan.summary).toMatchObject({
      completed_item_count: 0,
      open_item_count: 0,
    });
  });
  it("completion uses the latest edited record after a write retry", async () => {
    const save = mockSuccessfulWrite();
    await TodoListPkmService.setStatus({
      ...persistence,
      task,
      status: "done",
    });
    const build = save.mock.calls[0]![0].build;
    await build({
      ...coordinatorContext,
      currentDomainData: { _private: { tasks: [task] } },
    });
    const latest = {
      ...task,
      title: "Owner correction",
      notes: "Keep the newer notes",
      revision: 7,
    };
    const retried = await build({
      ...coordinatorContext,
      attempt: 1,
      currentDomainData: { _private: { tasks: [latest] } },
    });
    expect(readTodoListState(retried.domainData).tasks[0]).toMatchObject({
      title: latest.title,
      notes: latest.notes,
      revision: 8,
      status: "done",
      createdAt: task.createdAt,
    });
  });
  it("changing one task preserves all large legacy records beyond the former display cap", async () => {
    const save = mockSuccessfulWrite();
    const rows = Array.from({ length: 401 }, (_, i) => ({
      ...task,
      id: `legacy-${i}`,
      title: `title-${i}:` + "T".repeat(1000),
      notes: "N".repeat(5000),
      revision: 9,
    }));
    await TodoListPkmService.setStatus({
      ...persistence,
      task: rows[0]!,
      status: "done",
    });
    const plan = await save.mock.calls[0]![0].build({
      ...coordinatorContext,
      currentDomainData: { _private: { tasks: rows } },
    });
    const restored = readTodoListState(
      JSON.parse(JSON.stringify(plan.domainData)),
    ).tasks;
    expect(restored).toHaveLength(401);
    expect(restored.find((row) => row.id === "legacy-400")).toEqual(rows[400]);
    expect(restored.find((row) => row.id === "legacy-0")).toMatchObject({
      status: "done",
      revision: 10,
    });
  });
});

it("reuses each mail obligation and stops only the fulfilled document watch", async () => {
  vi.clearAllMocks();
  const save = mockSuccessfulWrite();
  const source = "ms1."+"x".repeat(32);
  const first = {key:"a".repeat(64), source_kind:"mail_thread" as const, account:"mail-c", connection:"slot-c", thread:source, source,
    title:"Get signed copy",participant:"Professor", debtor:"professor@example.test", waiting_on:"participant" as const,
    fulfilment:"Signed agreement", quote:"I will send the signed agreement on the 29th.",document:"Signed agreement",promised_wording:"on the 29th",due_date:"2026-11-29"};
  const second = {...first, key:"b".repeat(64),title:"Get pricing",quote:"I will send pricing."};
  let domain: Record<string,unknown> = {};
  async function apply(write: Promise<unknown>) {
    await write;
    const plan = await save.mock.calls.at(-1)![0].build({...coordinatorContext,currentDomainData:domain});
    domain = plan.domainData;
    return readTodoListState(domain).tasks;
  }
  await apply(TodoListPkmService.trackMail(persistence,first));
  await apply(TodoListPkmService.trackMail(persistence,second));
  let rows=await apply(TodoListPkmService.trackMail(persistence,first));
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.mailFollowup?.key === first.key)).toMatchObject({date:"2026-11-29", time:null, mailFollowup:{debtor:"professor@example.test",source,fulfilment:"Signed agreement",promised_wording:"on the 29th"}});
  rows=await apply(TodoListPkmService.updateMail(persistence,rows.find(r=>r.mailFollowup?.key===first.key)!,{watching:true}));
  rows=await apply(TodoListPkmService.updateMail(persistence,rows.find(r=>r.mailFollowup?.key===first.key)!,{received:{source,filename:"signed.pdf"}}));
  expect(rows.find(r=>r.mailFollowup?.key===first.key)).toMatchObject({status:"done",mailFollowup:{watching:false}});
  expect(rows.find(r=>r.mailFollowup?.key===second.key)?.status).toBe("pending");
});

describe("personal Task reminders", () => {
  const at = (offset: number) => new Date(Date.now() + offset).toISOString();
  function store(initial: TodoItem[]) {
    let domain: Record<string, unknown> = { _private: { tasks: initial } };
    const save = vi.mocked(PkmWriteCoordinator.saveMergedDomain);
    save.mockImplementation(async write => {
      const plan = await write.build({ ...coordinatorContext, currentDomainData: domain });
      await write.beforeEffect?.();
      if (!plan.unchanged) domain = plan.domainData;
      return { success: true, saveState: "saved", fullBlob: {}, idempotentReplay: !!plan.unchanged };
    });
    return (id: string) => readTodoListState(domain).tasks.find(row => row.id === id)!;
  }
  const original = { ...task, revision: 1 };
  const makeMail = (key: string): TodoItem => {
    const source = "ms1." + key.repeat(32);
    return { ...original, id: source, sourceAgent: "gmail", mailFollowup: {
      key: key.repeat(64), account: "account", connection: "grant", source_kind: "mail_thread",
      source, thread: source, title: "Get signed report", participant: "Professor",
      debtor: "professor@example.test", waiting_on: "participant", fulfilment: "Signed project report",
      quote: "I will send the signed report", document: "Signed report", promised_wording: null,
    } };
  };

  it("atomically completes only the matched watched Task and cancels its pending reminder", async () => {
    const first = makeMail("a"), other = makeMail("b");
    const row = store([first, other]);
    const dueAt = at(60_000);
    await TodoListPkmService.setPersonalReminder(persistence, first, dueAt);
    await TodoListPkmService.setPersonalReminder(persistence, other, dueAt);
    const watched = row(first.id), unaffected = row(other.id);
    expect(watched).toMatchObject({ mailFollowup: { watching: true }, personalReminder: { dueAt, state: "pending" } });
    const source = "ms1." + "z".repeat(32);
    await TodoListPkmService.updateMail(persistence, watched, { received: { source, filename: "signed.pdf" } }, () => true, async () => {});
    expect(row(first.id)).toMatchObject({ status: "done", revision: 3,
      personalReminder: { ...watched.personalReminder, state: "cancelled" },
      mailFollowup: { watching: false, received: { source, filename: "signed.pdf" } } });
    expect(row(other.id)).toEqual(unaffected);
    await TodoListPkmService.setStatus({ ...persistence, task: row(first.id), status: "pending" });
    expect(row(first.id).personalReminder?.state).toBe("cancelled");
  });

  it("retains the link through ordinary edits, refuses a stale replacement, and cancels explicitly", async () => {
    const row = store([original]), dueAt = at(60_000), later = at(120_000);
    await TodoListPkmService.setPersonalReminder(persistence, original, dueAt);
    const initial = row(original.id);
    await TodoListPkmService.update({ ...persistence, taskId: original.id, update: { notes: "Edited" } });
    expect(row(original.id).personalReminder).toEqual(initial.personalReminder);
    await TodoListPkmService.setPersonalReminder(persistence, row(original.id), later);
    const replacement = row(original.id);
    expect(replacement.personalReminder).toEqual({ ...initial.personalReminder, dueAt: later });
    await expect(TodoListPkmService.cancelPersonalReminder(persistence, initial)).rejects.toThrow("changed");
    expect(await TodoListPkmService.claimReminder(persistence, replacement, at(-1000), () => true)).toBe(false);
    await TodoListPkmService.cancelPersonalReminder(persistence, replacement);
    const cancelled = row(original.id);
    expect(cancelled).toMatchObject({ status: "pending", personalReminder: { ...replacement.personalReminder, state: "cancelled" } });
    await TodoListPkmService.cancelPersonalReminder(persistence, replacement);
    expect(row(original.id)).toEqual(cancelled);
  });

  it("claims a due Mail reminder only for the persisted watched source and its current grant", async () => {
    const original = makeMail("a");
    const pending = {
      ...original,
      mailFollowup: { ...original.mailFollowup!, watching: true },
      personalReminder: { id: crypto.randomUUID(), dueAt: at(-60_000), state: "pending" as const },
    };
    const row = store([pending]);
    const now = at(0);
    const current = () => true;
    const verify = vi.fn(async () => {});
    expect(await TodoListPkmService.claimReminder(persistence, pending, now, current)).toBe(false);
    for (const change of [{ connection: "other" }, { thread: "wrong" }, { source: "wrong" }, { account: "other" }]) {
      const stale = { ...pending, mailFollowup: { ...pending.mailFollowup, ...change } };
      expect(await TodoListPkmService.claimReminder(persistence, stale, now, current, verify)).toBe(false);
    }
    await expect(TodoListPkmService.claimReminder(persistence, pending, now, current, async () => {
      throw new Error("Grant revoked");
    })).rejects.toThrow("Grant revoked");
    expect(row(pending.id).personalReminder).toEqual(pending.personalReminder);
    expect(await TodoListPkmService.claimReminder(persistence, pending, now, current, verify)).toBe(true);
    expect(row(pending.id).personalReminder?.state).toBe("delivered");
    expect(await TodoListPkmService.claimReminder(persistence, pending, now, current, verify)).toBe(false);
  });

  it("preserves legacy rows, and a deleted Task cannot deliver a stale pending reminder", async () => {
    const legacy = { ...original, id: "legacy" };
    const row = store([original, legacy]);
    expect(row(legacy.id).personalReminder).toBeUndefined();
    await TodoListPkmService.setPersonalReminder(persistence, original, at(300_000));
    const scheduled = row(original.id);
    await TodoListPkmService.remove({ ...persistence, task: scheduled });
    expect(row(original.id)).toMatchObject({ status: "deleted", personalReminder: { state: "cancelled" } });
    expect(row(legacy.id)).toEqual(legacy);
    expect(await TodoListPkmService.claimReminder(persistence, scheduled, at(0), () => false)).toBe(false);
  });
});

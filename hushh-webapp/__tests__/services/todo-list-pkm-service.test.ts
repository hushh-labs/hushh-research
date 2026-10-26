import { webcrypto } from "node:crypto";
import { todoReminderInstant } from "@/lib/todos/reminder-schedule";
import { applyTodoOwnerOverrides } from "@/lib/todos/todo-list-model";
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


describe("task edits and atomic reminder metadata", () => {
  it("materializes an edited source task and preserves explicit cleared overrides across refresh", async () => {
    mockSuccessfulWrite();
    const projected = buildTodo(calendarTodoInput({ id: "calendar-private-id", title: "Provider title", start: { date: "2030-10-26" } })!);
    await TodoListPkmService.update({ ...persistence, taskId: projected.id, task: projected,
      update: { title: "Owner title", date: null, time: null, notes: "Private note", reminderAt: null } });
    const plan = await vi.mocked(PkmWriteCoordinator.saveMergedDomain).mock.calls.at(-1)![0].build({ ...coordinatorContext, currentDomainData: {} });
    const saved = readTodoListState(plan.domainData).tasks[0]!;
    expect(saved.ownerOverrides).toMatchObject({ title: "Owner title", date: null });
    expect(applyTodoOwnerOverrides({ ...projected, title: "New provider title" }, saved)).toMatchObject({ title: "Owner title", date: null, sourceId: projected.sourceId });
    expect(plan.writeProjections).toEqual([{ projectionType: "todo_reminders_v1", projectionVersion: 1, payload: { items: [] } }]);
  });
  it("refuses stale or deleted edits instead of reviving a removed task", async () => {
    mockSuccessfulWrite();
    await TodoListPkmService.update({ ...persistence, taskId: task.id, task: { ...task, revision: 1 }, update: { title: "Changed" } });
    const build = vi.mocked(PkmWriteCoordinator.saveMergedDomain).mock.calls.at(-1)![0].build;
    await expect(build({ ...coordinatorContext, currentDomainData: { _private: { tasks: [{ ...task, revision: 2 }] } } })).rejects.toThrow("changed on another device");
    await expect(build({ ...coordinatorContext, currentDomainData: { _private: { tasks: [{ ...task, status: "deleted" }] } } })).rejects.toThrow("no longer available");
  });
  it("does not pin untouched provider fields when editing a refreshed source snapshot", async () => {
    mockSuccessfulWrite();
    const stored = buildTodo(calendarTodoInput({ id: "source", title: "Old title", start: { date: "2030-10-26" } })!);
    const rendered = { ...stored, title: "New title", date: "2030-10-27", context: "With Ravi" };
    await TodoListPkmService.update({ ...persistence, taskId: rendered.id, task: rendered,
      update: { title: rendered.title, date: rendered.date, time: null, notes: "My note" } });
    const plan = await vi.mocked(PkmWriteCoordinator.saveMergedDomain).mock.calls.at(-1)![0].build({ ...coordinatorContext, currentDomainData: { _private: { tasks: [stored] } } });
    const saved = readTodoListState(plan.domainData).tasks[0]!;
    expect(saved.ownerOverrides).toEqual({ notes: "My note" });
    expect(applyTodoOwnerOverrides({ ...rendered, title: "Latest title" }, saved)).toMatchObject({ title: "Latest title", date: "2030-10-27", notes: "My note", context: "With Ravi" });
  });
  it("sends only opaque schedule metadata with the encrypted write and cancels on completion", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mockSuccessfulWrite();
    const scheduled = { ...task, reminderAt: "2030-10-26T08:00:00.000Z" };
    await TodoListPkmService.setStatus({ ...persistence, task: scheduled, status: "pending" });
    let build = vi.mocked(PkmWriteCoordinator.saveMergedDomain).mock.calls.at(-1)![0].build;
    const state = { ...coordinatorContext, currentDomainData: { _private: { tasks: [scheduled] } } };
    const plan = await build(state);
    const serialized = JSON.stringify(plan.writeProjections);
    expect(serialized).toContain("2030-10-26T08:00:00.000Z");
    expect(serialized).not.toContain(task.title);
    expect(serialized).not.toContain(task.id);
    expect(serialized).not.toContain(task.notes);
    await TodoListPkmService.setStatus({ ...persistence, task: scheduled, status: "done" });
    build = vi.mocked(PkmWriteCoordinator.saveMergedDomain).mock.calls.at(-1)![0].build;
    expect((await build(state)).writeProjections![0]!.payload).toEqual({ items: [] });
  });
  it("rejects invalid dates and time-only reminders while keeping date-only tasks valid", () => {
    expect(todoReminderInstant("2030-10-26", null)).toBeNull();
    expect(() => todoReminderInstant(null, "09:00")).toThrow();
    expect(() => todoReminderInstant("2030-02-30", "09:00")).toThrow();
    expect(() => todoReminderInstant("2030-10-26", "24:00")).toThrow();
    expect(new Date(todoReminderInstant("2032-02-29", "00:00")!).getDate()).toBe(29);
  });
});

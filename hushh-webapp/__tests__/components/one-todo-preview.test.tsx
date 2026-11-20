import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";
import type { CapabilityRead } from "@/lib/services/todo-capability-sources";
import { OneTodoPreview } from "@/components/agent/one-todo-preview";
import { agentTodoInput, buildTodo, calendarTodoInput, type TodoItem } from "@/lib/services/todo-list-pkm-service";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), remove: vi.fn(), create: vi.fn(), epoch: 0,
  events: [] as { id: string; title: string; start: { date: string } }[],
  actionables: [] as FeedActionable[],
  kyc: null as { count: number; workflowId: string } | null,
  calendarLoading: false, calendarError: null as string | null,
  retryCalendar: vi.fn(), retryEvents: vi.fn(), retryFeed: vi.fn(), retryKyc: vi.fn(),
  sourceAction: vi.fn(),
  reads: [] as CapabilityRead[],
}));
vi.mock("@/lib/todos/use-todo-capability-sources", () => ({ useTodoCapabilitySources: () => ({ reads: mocks.reads, loading: false, error: false, refresh: vi.fn() }) }));
vi.mock("@/lib/services/todo-list-pkm-service", async original => {
  const actual = await original<typeof import("@/lib/services/todo-list-pkm-service")>();
  return { ...actual, createTodo: mocks.create, TodoListPkmService: { load: mocks.load, setStatus: mocks.save, remove: mocks.remove } };
});
vi.mock("@/lib/feed/use-feed-actionables", () => ({ useFeedActionables: ({ enabled }: { enabled: boolean }) => ({ actionables: enabled ? mocks.actionables : [], loading: false, error: null, retry: mocks.retryFeed }) }));
vi.mock("@/lib/feed/use-feed-briefing", () => ({ useFeedBriefing: ({ enabled }: { enabled: boolean }) => ({ pendingKyc: enabled ? mocks.kyc : null, kycLoading: false, kycError: false, retryKyc: mocks.retryKyc }) }));
vi.mock("@/lib/calendar/use-calendar-connection-status", () => ({ useCalendarConnectionStatus: () => ({ connected: true, loaded: true, loading: false, error: null, refresh: mocks.retryCalendar }) }));
vi.mock("@/lib/calendar/use-calendar-upcoming-events", () => ({ useCalendarUpcomingEvents: ({ isConnected }: { isConnected: boolean }) => ({ events: isConnected ? mocks.events : [], loaded: !mocks.calendarLoading, loading: mocks.calendarLoading, error: mocks.calendarError, refresh: mocks.retryEvents }) }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({ useGmailConnectorStatus: () => ({ status: null }) }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => mocks.epoch, isVaultSessionEpochCurrent: (epoch: number) => epoch === mocks.epoch }));

const props = (uid = "owner", unlocked = true) => ({
  user: { uid, getIdToken: vi.fn().mockResolvedValue("fixture") } as unknown as User,
  ownerId: uid,
  vaultKey: unlocked ? "fixture-key" : null,
  vaultOwnerToken: unlocked ? "fixture-token" : null,
  isVaultUnlocked: unlocked,
});
const event = { id: "event-1", title: "Upcoming call", start: { date: "2099-01-01" } };
const actionable = {
  id: "review-1", todo: { source: "drive", title: "Review files", href: "/one/consent" },
  actions: [{ key: "allow", run: mocks.sourceAction }],
} as unknown as FeedActionable;
const select = (title: string) => screen.getByRole("checkbox", { name: `Mark ${title} as completed` });

describe("One profile To-do live-source parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch = 0;
    mocks.events = [];
    mocks.actionables = [];
    mocks.kyc = null;
    mocks.reads = [];
    mocks.calendarLoading = false;
    mocks.calendarError = null;
    mocks.load.mockResolvedValue({ tasks: [] });
    mocks.save.mockResolvedValue({ success: true });
    mocks.remove.mockResolvedValue({ success: true });
  });

  it("uses the shared task editor and retains the draft and identity after a failed save", async () => {
    mocks.create.mockResolvedValueOnce({ result: { success: false } })
      .mockImplementationOnce(async (input) => ({ task: buildTodo(input), result: { success: true } }));
    render(<OneTodoPreview {...props()} />);
    await screen.findByText("All clear.");
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Arrange files" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Arrange files");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Arrange files")).toBeVisible();
    expect(mocks.create.mock.calls[1]?.[0].id).toBe(mocks.create.mock.calls[0]?.[0].id);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("fetches Calendar, explicit agent tasks and KYC even when saved tasks are empty", async () => {
    mocks.events = [event];
    mocks.actionables = [actionable, actionable, { ...actionable, id: "history", todo: undefined }];
    mocks.kyc = { count: 2, workflowId: "kyc-1" };
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText(event.title)).toBeVisible();
    expect(screen.getAllByText("Review files")).toHaveLength(1);
    expect(screen.getByText("Review 2 information requests")).toBeVisible();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.sourceAction).not.toHaveBeenCalled();
    for (const text of ["Suggest tasks", "Refresh sources"]) {
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("checkbox", { name: "Let One suggest tasks from summaries." })).not.toBeInTheDocument();
  });

  it("reconciles saved completion and deletion before showing live sources", async () => {
    mocks.events = [event];
    mocks.actionables = [actionable];
    const calendar = buildTodo(calendarTodoInput(event)!);
    const agent = buildTodo(agentTodoInput(actionable.id, actionable.todo!)!);
    mocks.load.mockResolvedValue({ tasks: [{ ...calendar, status: "done" }, { ...agent, status: "deleted" }] });
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("All clear.")).toBeVisible();
    expect(screen.getByText(event.title)).not.toBeVisible();
    expect(screen.queryByText("Review files")).not.toBeInTheDocument();
  });

  it("keeps a live completion hidden through later renders without executing its source", async () => {
    mocks.actionables = [actionable];
    const view = render(<OneTodoPreview {...props()} />);
    await screen.findByText("Review files");
    fireEvent.click(select("Review files"));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ status: "done", task: expect.objectContaining({ title: "Review files" }) })));
    view.rerender(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("All clear.")).toBeVisible();
    expect(mocks.sourceAction).not.toHaveBeenCalled();
  });

  it("reports failed completion in detail and clears the error after a successful retry", async () => {
    mocks.events = [event];
    mocks.save.mockResolvedValueOnce({ success: false });
    render(<OneTodoPreview {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: event.title, exact: true }));
    const detail = screen.getByRole("region", { name: "Task details" });
    fireEvent.click(within(detail).getByRole("button", { name: "Mark as completed", exact: true }));
    expect(await within(detail).findByRole("alert")).toHaveTextContent("Couldn’t save. Try again.");
    fireEvent.click(within(detail).getByRole("button", { name: "Mark as completed", exact: true }));
    await waitFor(() => expect(within(detail).getByRole("button", { name: "Mark as not completed", exact: true })).toBeEnabled());
    expect(within(detail).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "Back to tasks" }));
    expect(await screen.findByRole("button", { name: "Task sources", exact: true })).toBeEnabled();
    expect(screen.queryByText("Your saved tasks could not refresh.")).not.toBeInTheDocument();
  });

  it("preserves a saved-read failure when a cached task mutation succeeds", async () => {
    const task = buildTodo({ title: "Cached task", type: "manual" });
    mocks.load.mockResolvedValue({ tasks: [task] });
    mocks.calendarError = "Unavailable";
    render(<OneTodoPreview {...props()} />);
    await screen.findByText(task.title);
    mocks.load.mockRejectedValueOnce(new Error("Saved list unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Try again", exact: true }));
    expect(await screen.findByText("Your saved tasks could not refresh.")).toBeVisible();
    fireEvent.click(select(task.title));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again", exact: true })).toBeEnabled());
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(screen.getByText("Your saved tasks could not refresh.")).toBeVisible();
  });

  it("keeps a failed removal open for retry and closes it only after a successful save", async () => {
    mocks.events = [event];
    mocks.remove.mockResolvedValueOnce({ success: false });
    render(<OneTodoPreview {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: event.title, exact: true }));
    const detail = screen.getByRole("region", { name: "Task details" });
    fireEvent.click(within(detail).getByRole("button", { name: "Remove task", exact: true }));
    expect(await within(detail).findByRole("alert")).toHaveTextContent("Couldn’t save. Try again.");
    expect(detail).toBeVisible();
    fireEvent.click(within(detail).getByRole("button", { name: "Remove task", exact: true }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Task details" })).not.toBeInTheDocument());
    expect(await screen.findByText("All clear.")).toBeVisible();
    expect(mocks.remove).toHaveBeenCalledTimes(2);
    expect(mocks.sourceAction).not.toHaveBeenCalled();
  });

  it("rediscovers completed tasks after remount and restores them from the same profile pane", async () => {
    const task = buildTodo({ id: "recover-completed", title: "Recover completed task", type: "manual" });
    mocks.load.mockResolvedValue({ tasks: [task] });
    const view = render(<OneTodoPreview {...props()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: `Mark ${task.title} as completed` }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ status: "done" })));
    view.unmount();
    mocks.load.mockResolvedValue({ tasks: [{ ...task, status: "done" }] });
    render(<OneTodoPreview {...props()} />);
    const summary = await screen.findByText("Completed (1)");
    fireEvent.click(summary);
    fireEvent.click(screen.getByRole("button", { name: task.title, exact: true }));
    const detail = screen.getByRole("region", { name: "Task details" });
    fireEvent.click(within(detail).getByRole("button", { name: "Mark as not completed", exact: true }));
    await waitFor(() => expect(within(detail).getByRole("button", { name: "Back to tasks" })).toBeEnabled());
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: "pending", task: expect.objectContaining({ id: task.id }) }));
    fireEvent.click(within(detail).getByRole("button", { name: "Back to tasks" }));
    expect(await screen.findByRole("checkbox", { name: `Mark ${task.title} as completed` })).toBeEnabled();
    expect(screen.queryByText("Completed (1)")).not.toBeInTheDocument();
  });

  it("rolls back a resolved unsuccessful write and offers retry", async () => {
    mocks.events = [event];
    mocks.save.mockResolvedValue({ success: false });
    render(<OneTodoPreview {...props()} />);
    await screen.findByText(event.title);
    fireEvent.click(select(event.title));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t save. Try again.");
    expect(screen.getByText(event.title)).toBeVisible();
    expect(select(event.title)).toBeEnabled();
  });

  it("retains saved rows on a source failure, retries sources, and avoids false empty success", async () => {
    mocks.calendarError = "Unavailable";
    mocks.load.mockResolvedValue({ tasks: [buildTodo({ title: "Existing saved task" })] });
    const view = render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Some tasks could not refresh.")).toBeVisible();
    expect(await screen.findByText("Existing saved task")).toBeVisible();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
    mocks.calendarError = null;
    mocks.events = [event];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    view.rerender(<OneTodoPreview {...props()} />);
    expect(await screen.findByText(event.title)).toBeVisible();
    expect(mocks.retryCalendar).toHaveBeenCalledOnce();
    expect(mocks.retryEvents).toHaveBeenCalledOnce();
    expect(mocks.retryFeed).toHaveBeenCalledOnce();
    expect(mocks.retryKyc).toHaveBeenCalledOnce();
  });

  it("does not report All clear when a live source failed and saved tasks are empty", async () => {
    mocks.calendarError = "Unavailable";
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Some tasks could not refresh.")).toBeVisible();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it.each(["wallet", "messages", "ria", "pkm"] as const)("does not turn an unavailable selected %s source into an empty success", async capability => {
    mocks.load.mockResolvedValue({ tasks: [], selectedCapabilities: [capability] });
    mocks.reads = [{ coverage: { capability, count: 0, status: "unavailable" }, evidence: [] }];
    const view = render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Some tasks could not refresh.")).toBeVisible();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    mocks.reads = [{ coverage: { capability, count: 0, status: "ready" }, evidence: [] }];
    view.rerender(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("All clear.")).toBeVisible();
    expect(screen.queryByText("Some tasks could not refresh.")).not.toBeInTheDocument();
  });

  it("shows saved items while Calendar is still loading", async () => {
    mocks.calendarLoading = true;
    mocks.load.mockResolvedValue({ tasks: [buildTodo({ title: "Saved task" })] });
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Saved task")).toBeVisible();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
  });

  it("retries a failed saved read rather than displaying an empty success", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Read unavailable"));
    render(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("Your saved tasks could not refresh.")).toBeVisible();
    expect(screen.queryByText("All clear.")).not.toBeInTheDocument();
    mocks.load.mockResolvedValue({ tasks: [buildTodo({ title: "Recovered item" })] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Recovered item")).toBeVisible();
  });

  it("keeps a dismissed live Calendar task hidden and persists its tombstone", async () => {
    mocks.events = [event];
    const view = render(<OneTodoPreview {...props()} />);
    await screen.findByText(event.title);
    fireEvent.click(screen.getByRole("button", { name: `Delete ${event.title}` }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ sourceAgent: "calendar", title: event.title }) })));
    view.rerender(<OneTodoPreview {...props()} />);
    expect(await screen.findByText("All clear.")).toBeVisible();
    expect(screen.queryByText(event.title)).not.toBeInTheDocument();
  });

  it("does not show live tasks before saved dismissal state finishes loading", async () => {
    mocks.events = [event];
    let resolve!: (value: { tasks: TodoItem[] }) => void;
    mocks.load.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    render(<OneTodoPreview {...props()} />);
    expect(screen.queryByText(event.title)).not.toBeInTheDocument();
    const task = buildTodo(calendarTodoInput(event)!);
    await act(async () => resolve({ tasks: [{ ...task, status: "deleted" }] }));
    expect(await screen.findByText("All clear.")).toBeVisible();
  });

  it.each(["lock", "owner", "epoch"])("drops late saved reads after a %s change", async change => {
    let resolve!: (value: { tasks: TodoItem[] }) => void;
    mocks.load.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const view = render(<OneTodoPreview {...props()} />);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
    if (change === "epoch") mocks.epoch += 1;
    view.rerender(<OneTodoPreview {...props(change === "owner" ? "other" : "owner", change !== "lock")} />);
    await act(async () => resolve({ tasks: [buildTodo({ title: "Private old task" })] }));
    expect(screen.queryByText("Private old task")).not.toBeInTheDocument();
    if (change === "lock") expect(screen.getByText("Unlock your vault to view your to-do list.")).toBeVisible();
  });
});

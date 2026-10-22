import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  TodoListPage,
} from "@/components/todos/todo-list-page";
import {
  TodoListPkmService,
  buildTodo,
  agentTodoInput,
  type TodoItem,
} from "@/lib/services/todo-list-pkm-service";
import * as todoService from "@/lib/services/todo-list-pkm-service";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";

const mocks = vi.hoisted(() => ({
  user: { uid: "todo-owner", getIdToken: vi.fn() },
  unlocked: true,
  actionables: [] as FeedActionable[],
  feedError: null as string | null,
  feedLoading: false,
  retryFeed: vi.fn(),
  pendingKyc: null as { count: number; workflowId: string } | null,
  events: [
    {
      id: "calendar-event-1",
      title: "Review the plan",
      start: { date: "2026-10-10" },
    },
  ],
}));

vi.mock("@/lib/todos/use-todo-capability-sources", () => ({ useTodoCapabilitySources: () => ({ reads: [], loading: false, error: false, refresh: vi.fn() }) }));
vi.mock("@/lib/feed/use-feed-actionables", () => ({
  useFeedActionables: ({ enabled }: { enabled: boolean }) => ({
    actionables: enabled ? mocks.actionables : [],
    error: mocks.feedError,
    loading: mocks.feedLoading,
    progressError: null,
    progressLoading: false,
    retry: mocks.retryFeed,
  }),
}));
vi.mock("@/lib/feed/use-feed-briefing", () => ({
  useFeedBriefing: ({ enabled }: { enabled: boolean }) => ({
    pendingKyc: enabled ? mocks.pendingKyc : null, kycLoading: false, kycError: false, retryKyc: async () => {},
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: mocks.unlocked,
    vaultKey: "test-vault-key",
    vaultOwnerToken: "test-owner-token",
  }),
}));

vi.mock("@/lib/calendar/use-calendar-connection-status", () => ({
  useCalendarConnectionStatus: () => ({ connected: true, loaded: true, loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock("@/lib/calendar/use-calendar-upcoming-events", () => ({
  useCalendarUpcomingEvents: () => ({ events: mocks.events, loaded: true, loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  AppPageHeaderRegion: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { loadDomainData: vi.fn() },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: vi.fn() },
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { promise: vi.fn(), error: vi.fn() },
}));

describe("TodoListPage row actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.unlocked = true;
    mocks.user.uid = "todo-owner";
    mocks.actionables = [];
    mocks.feedError = null;
    mocks.feedLoading = false;
    mocks.pendingKyc = null;
    mocks.retryFeed.mockReset().mockResolvedValue(undefined);
    mocks.events = [
      {
        id: "calendar-event-1",
        title: "Review the plan",
        start: { date: "2026-10-10" },
      },
    ];
    vi.spyOn(TodoListPkmService, "load").mockResolvedValue({ tasks: [] });
    vi.spyOn(TodoListPkmService, "remove").mockResolvedValue({
      success: true,
      saveState: "saved",
      fullBlob: {},
    });
  });

  it("shows a truthful empty collection and distinguishes completed-only state", async () => {
    mocks.events = [];
    const view = render(<TodoListPage />);
    expect(await screen.findByRole("heading", { name: "No tasks yet" })).toBeVisible();
    expect(screen.getByText("Add an item to get started.")).toBeVisible();
    expect(screen.queryByText("All clear")).not.toBeInTheDocument();

    const done = { ...buildTodo({ id: "finished", title: "Finished item", type: "manual" }), status: "done" as const };
    vi.mocked(TodoListPkmService.load).mockResolvedValue({ tasks: [done] });
    view.unmount();
    render(<TodoListPage />);
    expect(await screen.findByRole("heading", { name: "No pending tasks" })).toBeVisible();
    expect(screen.getByText("New tasks will appear here.")).toBeVisible();
  });

  it("never presents an empty success when saved items fail to load", async () => {
    mocks.events = [];
    vi.mocked(TodoListPkmService.load).mockRejectedValue(new Error("read failed"));
    render(<TodoListPage />);
    expect(await screen.findByText("Your saved items couldn’t load.")).toBeVisible();
    expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument();
    expect(screen.queryByText("No pending tasks")).not.toBeInTheDocument();
    vi.mocked(TodoListPkmService.load).mockResolvedValue({ tasks: [] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "No tasks yet" })).toBeVisible();
  });

  it("never inserts a late create into another owner's list or suggestions", async () => {
    mocks.events = [];
    let finishCreate!: (value: { task: TodoItem; result: { success: boolean } }) => void;
    vi.spyOn(todoService, "createTodo").mockImplementation(() => new Promise(resolve => { finishCreate = resolve; }) as ReturnType<typeof todoService.createTodo>);
    const view = render(<TodoListPage />);
    await screen.findByRole("heading", { name: "No tasks yet" });
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    fireEvent.change(screen.getByPlaceholderText("What do you want to do?"), { target: { value: "Owner A private task" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(finishCreate).toBeDefined());
    mocks.user.uid = "another-owner";
    view.rerender(<TodoListPage />);
    await screen.findByRole("heading", { name: "No tasks yet" });
    await act(async () => finishCreate({ task: buildTodo({ title: "Owner A private task", type: "manual" }), result: { success: true } }));
    expect(screen.queryByText("Owner A private task")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No tasks yet" })).toBeVisible();
  });

  it("does not reveal a late saved read after the vault locks", async () => {
    mocks.events = [];
    let finishRead!: (state: { tasks: TodoItem[] }) => void;
    vi.mocked(TodoListPkmService.load).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const view = render(<TodoListPage />);
    await waitFor(() => expect(TodoListPkmService.load).toHaveBeenCalledOnce());
    mocks.unlocked = false;
    view.rerender(<TodoListPage />);
    await act(async () => { finishRead({ tasks: [buildTodo({ id: "late", title: "Private late task", type: "manual" })] }); });
    expect(screen.queryByText("Private late task")).not.toBeInTheDocument();
    expect(screen.getByText("Unlock your vault to see your list.")).toBeVisible();
  });

  it("projects explicit agent tasks once, saves only completion and never executes the source action", async () => {
    const run = vi.fn();
    const item = {
      id: "consent:review-1",
      title: "A request",
      todo: { source: "drive", title: "Review shared files 📁", href: "/one/consent?request_id=review-1" },
      actions: [{ key: "allow", run }],
    } as FeedActionable;
    mocks.actionables = [item, item, { ...item, id: "historical", todo: undefined }];
    const save = vi.spyOn(TodoListPkmService, "setStatus").mockResolvedValue({ success: true, saveState: "saved", fullBlob: {} });
    const create = vi.spyOn(TodoListPkmService, "create");
    const view = render(<TodoListPage />);
    const checkbox = await screen.findByRole("checkbox", { name: "Mark Review shared files 📁 as completed" });
    expect(screen.getAllByText("Review shared files 📁")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Open Review shared files 📁" })).toHaveAttribute("href", item.todo!.href);
    expect(screen.getByText("Drive")).toBeVisible();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(screen.queryByText("Review shared files 📁")).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();

    const task = save.mock.calls[0]![0].task;
    vi.mocked(TodoListPkmService.load).mockResolvedValue({ tasks: [{ ...task, status: "done" }] });
    view.unmount();
    render(<TodoListPage />);
    await screen.findByText("Completed");
    expect(screen.queryByText("Review shared files 📁")).not.toBeInTheDocument();
  });

  it("does not revive resolved live tasks from stored pending snapshots and retains available lanes on partial failure", async () => {
    mocks.events = [];
    const saved = buildTodo(agentTodoInput("connection:gone", { source: "connections", title: "Resolved request", href: "/one/connect" })!);
    vi.mocked(TodoListPkmService.load).mockResolvedValue({ tasks: [saved] });
    mocks.feedError = "private raw provider diagnostic";
    mocks.actionables = [{ id: "location:live", todo: { source: "location", title: "Review location request", href: "/one/location?requestId=live" } } as FeedActionable];
    render(<TodoListPage />);
    await screen.findByText("Review location request");
    await waitFor(() => expect(TodoListPkmService.load).toHaveBeenCalled());
    expect(screen.queryByText("Resolved request")).not.toBeInTheDocument();
    expect(screen.queryByText("private raw provider diagnostic")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry agent tasks" }));
    await waitFor(() => expect(mocks.retryFeed).toHaveBeenCalledOnce());
  });

  it("includes the existing KYC queue and gives a later failed agent run its own task identity", async () => {
    mocks.events = [];
    mocks.pendingKyc = { count: 2, workflowId: "kyc-fixture" };
    const item = { id: "task:refresh", todo: { key: "task:refresh:run-1", source: "agent", title: "Review refresh", href: "/one/feed" } } as FeedActionable;
    const completed = { ...buildTodo(agentTodoInput(item.id, item.todo!)!), status: "done" as const };
    vi.mocked(TodoListPkmService.load).mockResolvedValue({ tasks: [completed] });
    mocks.actionables = [item];
    const view = render(<TodoListPage />);
    await screen.findByText("Completed");
    expect(screen.queryByText("Review refresh")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Review 2 information requests" })).toHaveAttribute("href", "/one/gmail?workspace=kyc");
    mocks.actionables = [{ ...item, todo: { ...item.todo!, key: "task:refresh:run-2" } }];
    view.rerender(<TodoListPage />);
    expect(await screen.findByRole("checkbox", { name: "Mark Review refresh as completed" })).toBeVisible();
  });

  it("hides a completed Calendar item immediately and keeps it hidden when saved state reloads", async () => {
    let finishSave!: (
      result: Awaited<ReturnType<typeof TodoListPkmService.setStatus>>,
    ) => void;
    const save = vi.spyOn(TodoListPkmService, "setStatus").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    const view = render(<TodoListPage />);
    const checkbox = await screen.findByRole("checkbox", {
      name: "Mark Review the plan as completed",
    });
    await waitFor(() => expect(TodoListPkmService.load).toHaveBeenCalled());

    fireEvent.click(checkbox);

    expect(screen.queryByText("Review the plan")).not.toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({ sourceAgent: "calendar" }),
        status: "done",
      }),
    );
    await act(async () => {
      finishSave({ success: true, saveState: "saved", fullBlob: {} });
    });

    const task = save.mock.calls[0]![0].task;
    vi.mocked(TodoListPkmService.load).mockResolvedValue({
      tasks: [{ ...task, status: "done", completedAt: "2026-10-09T10:00:00Z" }],
    });
    view.unmount();
    render(<TodoListPage />);

    await screen.findByText("Completed");
    expect(screen.queryByText("Review the plan")).not.toBeInTheDocument();
  });

  it("restores an item when completion cannot be saved", async () => {
    let finishSave!: (
      result: Awaited<ReturnType<typeof TodoListPkmService.setStatus>>,
    ) => void;
    vi.spyOn(TodoListPkmService, "setStatus").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    render(<TodoListPage />);
    const checkbox = await screen.findByRole("checkbox", {
      name: "Mark Review the plan as completed",
    });
    await waitFor(() => expect(TodoListPkmService.load).toHaveBeenCalled());

    fireEvent.click(checkbox);
    expect(screen.queryByText("Review the plan")).not.toBeInTheDocument();
    await act(async () => {
      finishSave({ success: false, saveState: "failed", fullBlob: {} });
    });

    expect(
      await screen.findByRole("checkbox", {
        name: "Mark Review the plan as completed",
      }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("waits for confirmation before deleting an added item", async () => {
    const task = buildTodo({
      id: "todo-1",
      title: "Call family",
      type: "manual",
    });
    vi.mocked(TodoListPkmService.load).mockResolvedValue({ tasks: [task] });
    render(<TodoListPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete Call family" }),
    );
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(TodoListPkmService.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(TodoListPkmService.remove).not.toHaveBeenCalled();
    expect(screen.getByText("Call family")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Delete Call family" }),
      ).toHaveFocus(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete Call family" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete", exact: true }),
    );
    await waitFor(() =>
      expect(TodoListPkmService.remove).toHaveBeenCalledWith(
        expect.objectContaining({
          task: expect.objectContaining({ id: "todo-1" }),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Call family")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add item" })).toHaveFocus(),
    );
  });
  it("counts only today's scheduled cohort in daily progress", async () => {
    mocks.events = [];
    const date = new Date();
    const today = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
    const anotherDate = today === "2026-01-01" ? "2026-01-02" : "2026-01-01";
    const due = buildTodo({ id: "due", title: "Today's item", date: today });
    const finished = {
      ...buildTodo({ id: "done", title: "Done today", date: today }),
      status: "done" as const,
    };
    const historical = {
      ...buildTodo({
        id: "history",
        title: "Historical item",
        date: anotherDate,
      }),
      status: "done" as const,
    };
    vi.mocked(TodoListPkmService.load).mockResolvedValue({
      tasks: [due, finished, historical],
    });
    vi.spyOn(TodoListPkmService, "setStatus").mockResolvedValue({
      success: true,
      saveState: "saved",
      fullBlob: {},
    });
    render(<TodoListPage />);
    const progress = await screen.findByRole("progressbar", {
      name: "Today's completion",
    });
    expect(progress).toHaveAttribute("aria-valuemax", "2");
    expect(progress).toHaveAttribute("aria-valuenow", "1");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Mark Today's item as completed" }),
    );
    await waitFor(() => expect(progress).toHaveAttribute("aria-valuenow", "2"));
    expect(
      screen.queryByRole("heading", { name: "Today's item" }),
    ).not.toBeInTheDocument();
  });

  it("keeps task titles and daily progress hidden while the vault is locked", () => {
    mocks.unlocked = false;
    render(<TodoListPage />);
    expect(screen.queryByText("Review the plan")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(TodoListPkmService.load).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add item" })).toBeDisabled();
  });

  it("dismisses protected dialogs when the vault locks without mutating the item", async () => {
    const view = render(<TodoListPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete Review the plan" }),
    );
    expect(screen.getByRole("alertdialog")).toBeVisible();

    mocks.unlocked = false;
    view.rerender(<TodoListPage />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Review the plan")).not.toBeInTheDocument();
    expect(TodoListPkmService.remove).not.toHaveBeenCalled();

    mocks.unlocked = true;
    view.rerender(<TodoListPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Title", exact: true }),
      { target: { value: "Private draft" } },
    );
    mocks.unlocked = false;
    view.rerender(<TodoListPage />);
    expect(
      screen.queryByRole("textbox", { name: "Title", exact: true }),
    ).not.toBeInTheDocument();
    mocks.unlocked = true;
    view.rerender(<TodoListPage />);
    await screen.findByRole("button", { name: "Delete Review the plan" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    expect(
      screen.getByRole("textbox", { name: "Title", exact: true }),
    ).toHaveValue("");
  });


});

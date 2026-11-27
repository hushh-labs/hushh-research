import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { FILE_ORGANIZATION_TEMPLATE, ONE_TASK_TEMPLATE, PodScheduledTasksClient, type ScheduledTask } from "@/lib/services/pod-scheduled-tasks";

import {
  TodoListPage,
} from "@/components/todos/todo-list-page";
import {
  TodoListPkmService,
  buildTodo,
  agentTodoInput,
  type TodoItem,
} from "@/lib/services/todo-list-pkm-service";
import { useTodoLiveTasks } from "@/lib/todos/use-todo-live-tasks";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import * as todoService from "@/lib/services/todo-list-pkm-service";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";
import type { RedactedCalendarEvent } from "@/lib/calendar/use-calendar-upcoming-events";
import type { CapabilityRead } from "@/lib/services/todo-capability-sources";

function deferredWrite() {
  let resolve!: (result: Awaited<ReturnType<typeof TodoListPkmService.setStatus>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof TodoListPkmService.setStatus>>>(done => { resolve = done; });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  native: false,
  nativeFailed: false,
  search: "",
  workspace: null as Parameters<typeof import("@/lib/capacitor/use-native-workspace").useNativeWorkspace>[0] | null,
  user: { uid: "todo-owner", getIdToken: vi.fn() },
  unlocked: true,
  actionables: [] as FeedActionable[],
  feedError: null as string | null,
  feedLoading: false,
  retryFeed: vi.fn(),
  reads: [] as CapabilityRead[],
  mailError: null as string | null,
  retrySources: vi.fn(),
  pendingKyc: null as { count: number; workflowId: string } | null,
  events: [
    {
      id: "calendar-event-1",
      title: "Review the plan",
      start: { date: "2026-10-10" },
      end: null,
      status: null,
    },
  ] as RedactedCalendarEvent[],
}));

vi.mock("@/lib/capacitor/native-presentation-policy", () => ({
  customNativePresentationEnabled: () => mocks.native,
  nativeOwnedChoicesEnabled: () => false,
}));
vi.mock("@/lib/capacitor/use-native-workspace", () => ({
  useNativeWorkspace: (options: typeof mocks.workspace) => { mocks.workspace = options; return options?.active === false ? "web" : "native"; },
  useNativeWorkspacePresentation: () => ({ owner: {}, status: { phase: mocks.nativeFailed ? "web" : "native", reason: mocks.nativeFailed ? "failure" : "active", held: false } }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/tasks", useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(mocks.search) }));
vi.mock("@/lib/todos/use-todo-capability-sources", () => ({ useTodoCapabilitySources: () => ({ reads: mocks.reads, loading: false, error: false, refresh: mocks.retrySources }) }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({ useGmailConnectorStatus: () => ({ status: { connected: true }, loadingStatus: false, statusError: mocks.mailError }) }));
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
  useAuth: () => ({ user: mocks.user, userId: mocks.user.uid }),
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
    mocks.native = false;
    mocks.nativeFailed = false;
    mocks.search = "";
    mocks.workspace = null;
    mocks.unlocked = true;
    mocks.user.uid = "todo-owner";
    publishValidatedAuthSessionPrincipal({ ownerId: mocks.user.uid, firebaseUid: mocks.user.uid, accountGeneration: 1 });
    mocks.actionables = [];
    mocks.feedError = null;
    mocks.feedLoading = false;
    mocks.reads = [];
    mocks.mailError = null;
    mocks.retrySources.mockReset().mockResolvedValue(undefined);
    mocks.pendingKyc = null;
    mocks.retryFeed.mockReset().mockResolvedValue(undefined);
    mocks.events = [
      {
        id: "calendar-event-1",
        title: "Review the plan",
        start: { date: "2026-10-10" },
        end: null,
        status: null,
      },
    ];
    vi.spyOn(TodoListPkmService, "load").mockResolvedValue({ tasks: [] });
    vi.spyOn(TodoListPkmService, "remove").mockResolvedValue({
      success: true,
      saveState: "saved",
      fullBlob: {},
    });
  });

  it.each(["once", "daily"] as const)("confirms a %s agent run and reads its completed result from the details", async repeat => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
    try {
      vi.spyOn(AuthService, "getCurrentUser").mockReturnValue(mocks.user as ReturnType<typeof AuthService.getCurrentUser>);
      vi.spyOn(ApiService, "getPersonalAgentStatus").mockResolvedValue({ hostingMode: "hussh_pods" } as Awaited<ReturnType<typeof ApiService.getPersonalAgentStatus>>);
      const task: ScheduledTask = {
        id: `schedule_${"b".repeat(32)}`, title: "Rehearsal checklist", capability: ONE_TASK_TEMPLATE,
        revision: 3, state: "completed", repeat, timezone: "UTC",
        next_run_at: 1_900_000_000, authorization_expires_at: 2_200_000_000,
        last_run: { id: "c".repeat(32), state: "completed", started_at: 1_900_000_000 },
      };
      const status = vi.spyOn(PodScheduledTasksClient.prototype, "status");
      const available = {
        available: true, code: null, authorization_limit_at: 2_200_000_000,
        templates: [ONE_TASK_TEMPLATE], repeat_modes: ["once", "daily"] as ("once" | "daily")[],
      };
      status.mockResolvedValueOnce({ ...available, tasks: [] }).mockResolvedValue({ ...available, tasks: [task] });
      const schedule = vi.spyOn(PodScheduledTasksClient.prototype, "scheduleOne")
        .mockRejectedValueOnce(new Error("SCHEDULE_RESPONSE_UNCONFIRMED")).mockResolvedValue(task);
      const read = vi.spyOn(PodScheduledTasksClient.prototype, "readRunResult").mockResolvedValue({
        outcome: "completed", summary: "Time one practice run, review transitions, and check the ending.",
      });
      render(<TodoListPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Schedule a run" }));
      const dialog = screen.getByRole("dialog", { name: "Schedule a run" });
      fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: task.title } });
      fireEvent.change(within(dialog).getByLabelText("What should your agent do?"), { target: { value: "Draft three rehearsal steps." } });
      if (repeat === "daily") {
        fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "Repeat" }), { key: "ArrowDown" });
        fireEvent.click(await screen.findByRole("option", { name: "Daily" }));
        fireEvent.change(within(dialog).getByLabelText(/End at/), { target: { value: "2031-01-18T12:00" } });
      }
      fireEvent.change(within(dialog).getByLabelText(/Run at|First run/), { target: { value: "2031-01-15T12:00" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirm run" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("couldn’t be confirmed");
      expect(within(dialog).getByLabelText("What should your agent do?")).toBeDisabled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry confirmation" }));
      const details = await screen.findByRole("region", { name: "Scheduled run details" });
      expect(schedule).toHaveBeenCalledTimes(2);
      expect(schedule.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ title: task.title, goal: "Draft three rehearsal steps." }));
      if (repeat === "daily") {
        expect(schedule.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
          recurrence: { repeat: "daily" },
          expiresAt: new Date("2031-01-18T12:00").getTime() / 1000,
        }));
      }
      expect(schedule.mock.calls[1]?.[0]).toEqual(schedule.mock.calls[0]?.[0]);
      fireEvent.click(await within(details).findByRole("button", { name: "View result" }));
      expect(await within(details).findByText(/Time one practice run/)).toBeVisible();
      expect(read).toHaveBeenCalledWith(task, expect.any(AbortSignal), task.last_run!.id);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("shows and confirms only the action parked for this scheduled occurrence", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
    try {
      vi.spyOn(AuthService, "getCurrentUser").mockReturnValue(mocks.user as ReturnType<typeof AuthService.getCurrentUser>);
      vi.spyOn(ApiService, "getPersonalAgentStatus").mockResolvedValue({ hostingMode: "hussh_pods" } as Awaited<ReturnType<typeof ApiService.getPersonalAgentStatus>>);
      const occurrenceId = "d".repeat(32);
      const task: ScheduledTask = {
        id: `schedule_${"e".repeat(32)}`, title: "Send rehearsal update", capability: ONE_TASK_TEMPLATE,
        revision: 3, state: "needs_review", repeat: "once", timezone: "UTC", review_available: true,
        next_run_at: 1_900_000_000, authorization_expires_at: 2_200_000_000,
        last_run: { id: occurrenceId, state: "needs_review", started_at: 1_900_000_000 },
      };
      const completed: ScheduledTask = {
        ...task, revision: 5, state: "completed", review_available: false,
        last_run: { ...task.last_run!, state: "completed" },
      };
      const status = { available: true, code: null, authorization_limit_at: 2_200_000_000, templates: [ONE_TASK_TEMPLATE] };
      let visibleTask = task;
      vi.spyOn(PodScheduledTasksClient.prototype, "status")
        .mockImplementation(async () => ({ ...status, tasks: [visibleTask] }));
      const preview = {
        kind: "mcp_call_review" as const, version: 1 as const, connectorId: "test-connector",
        toolName: `mcp_${"b".repeat(40)}`, directiveId: `dir_${"c".repeat(32)}`,
        pendingHandle: `one_secret_ref:${"d".repeat(32)}`, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        connectorLabel: "Test connector", toolLabel: "send_update", arguments: { text: "Rehearsal approved" },
        podReview: {
          kind: "pod_mcp_review_v1" as const, ownerId: mocks.user.uid, hushhId: "pod", podKeyId: "pod-key",
          environment: "dev", epoch: 1, conversationId: `scheduled_${occurrenceId}`,
          connectorId: "test-connector", toolName: `mcp_${"b".repeat(40)}`, callId: "call",
          catalogRevision: "1", commitment: "a".repeat(64), serviceUid: "service",
        },
      };
      const review = { scheduleId: task.id, occurrenceId, revision: 4, confirmationId: "exact-confirmation", preview };
      const approval = {
        directiveId: preview.directiveId, pendingHandle: preview.pendingHandle, connectorId: preview.connectorId,
        toolName: preview.toolName, receipt: "a".repeat(32),
      };
      const load = vi.spyOn(PodScheduledTasksClient.prototype, "reviewParkedRun").mockResolvedValue(review);
      const confirm = vi.spyOn(ExternalConnectorService, "confirmMcpCall").mockResolvedValue(approval);
      const resume = vi.spyOn(PodScheduledTasksClient.prototype, "continueParkedRun").mockImplementation(async () => {
        visibleTask = completed;
        return completed;
      });
      render(<TodoListPage />);
      fireEvent.click(await screen.findByRole("button", { name: /Send rehearsal update Scheduled run/ }));
      expect(load).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Review action" }));
      let dialog = await screen.findByRole("dialog", { name: "Review scheduled action" });
      expect(await within(dialog).findByText("Rehearsal approved")).toBeVisible();
      await act(async () => { expect(unwindBackLayer("/one/tasks")).toBe(true); });
      expect(screen.queryByRole("dialog", { name: "Review scheduled action" })).not.toBeInTheDocument();
      expect(confirm).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Review action" }));
      dialog = await screen.findByRole("dialog", { name: "Review scheduled action" });
      expect(await within(dialog).findByText("Rehearsal approved")).toBeVisible();
      fireEvent.click(within(dialog).getByRole("button", { name: "Allow once" }));
      await waitFor(() => expect(resume).toHaveBeenCalledWith(review, approval, expect.any(AbortSignal)));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(await screen.findByText(/^Latest run: Completed/)).toBeVisible();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { native: false, deepLink: false },
    { native: false, deepLink: true },
    { native: true, deepLink: true },
  ])("shows scheduled runs on Tasks with native=$native and deepLink=$deepLink", async ({ native, deepLink }) => {
    mocks.native = native;
    const id = `schedule_${"a".repeat(32)}`;
    mocks.search = deepLink ? `scheduled=${id}` : "";
    mocks.feedError = "Synthetic source refresh failure";
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
    try {
      vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(native);
      vi.spyOn(AuthService, "getCurrentUser").mockReturnValue(native ? null : mocks.user as ReturnType<typeof AuthService.getCurrentUser>);
      vi.spyOn(ApiService, "getPersonalAgentStatus").mockResolvedValue({ hostingMode: "hussh_pods" } as Awaited<ReturnType<typeof ApiService.getPersonalAgentStatus>>);
      const run = { id: "b".repeat(32), state: "completed", started_at: 1100, finished_at: 1150 };
      const earlierRun = { id: "c".repeat(32), state: "failed", started_at: 1000, finished_at: 1050 };
      vi.spyOn(PodScheduledTasksClient.prototype, "status").mockResolvedValue({
        available: true, code: null, authorization_limit_at: 3000, templates: [FILE_ORGANIZATION_TEMPLATE],
        run_now_available: true,
        tasks: [{ id, title: "Organize Minutes.txt", capability: FILE_ORGANIZATION_TEMPLATE,
          revision: 3, state: "scheduled", repeat: "monthly", timezone: "UTC",
          next_run_at: Math.floor(new Date(2030, 0, 15, 12).getTime() / 1000),
          authorization_expires_at: 2_000_000_000, last_run: run, recent_runs: [run, earlierRun] }],
      });
      const control = vi.spyOn(PodScheduledTasksClient.prototype, "control")
        .mockImplementation(async task => ({ ...task, revision: task.revision + 1, run_now_pending: true }));
      render(<TodoListPage />);
      const panel = await screen.findByRole(native ? "dialog" : "region", { name: "Scheduled runs" });
      expect(await within(panel).findByText("Organize Minutes.txt")).toBeVisible();
      let details = panel;
      if (!native) {
        expect(screen.queryByRole("dialog", { name: "Scheduled runs" })).not.toBeInTheDocument();
        expect(screen.getByText(/Some agent tasks couldn’t refresh/)).toBeVisible();
        expect(within(panel).getByRole("link", { name: "Schedule in Files" })).toHaveAttribute("href", "/one/files");
        expect(within(panel).queryByText(/^Latest run:/)).not.toBeInTheDocument();
        fireEvent.click(within(panel).getByRole("button", { name: /Organize Minutes.txt Scheduled run/ }));
        details = screen.getByRole("region", { name: "Scheduled run details" });
        fireEvent.click(within(details).getByRole("button", { name: "Refresh scheduled run" }));
        expect(details).toBeVisible();
        expect(await within(details).findByText(/^Latest run: Completed/)).toBeVisible();
      }
      expect(within(panel).queryByRole("group", { name: "Schedule view" })).not.toBeInTheDocument();
      expect(within(details).getByText("Monthly")).toBeVisible();
      expect(within(details).getByText(/^Latest run: Completed/)).toBeVisible();
      const history = within(details).getByText("Run history").closest("details")!;
      expect(within(history).getByText(/^Failed/)).toBeInTheDocument();
      expect(within(history).queryByText(/^Completed/)).not.toBeInTheDocument();
      fireEvent.click(within(details).getByRole("button", { name: "Run now" }));
      expect(await within(details).findByText(/^Run requested/)).toBeVisible();
      expect(control).toHaveBeenCalledWith(expect.objectContaining({ id, revision: 3 }), "run_now", expect.any(AbortSignal));
      if (!native) {
        expect(within(details).getByRole("button", { name: "Back to tasks" })).toBeVisible();
        act(() => { expect(unwindBackLayer("/one/tasks")).toBe(true); });
        expect(within(await screen.findByRole("region", { name: "Scheduled runs" }))
          .getByRole("button", { name: /Organize Minutes.txt Scheduled run/ })).toBeVisible();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not read private schedules for a conflicting native Firebase session", async () => {
    mocks.native = true;
    mocks.search = "scheduled=1";
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
    try {
      vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
      vi.spyOn(AuthService, "getCurrentUser").mockReturnValue({ uid: "different-account" } as NonNullable<ReturnType<typeof AuthService.getCurrentUser>>);
      const hosting = vi.spyOn(ApiService, "getPersonalAgentStatus").mockResolvedValue({ hostingMode: "hussh_pods" } as Awaited<ReturnType<typeof ApiService.getPersonalAgentStatus>>);
      const schedules = vi.spyOn(PodScheduledTasksClient.prototype, "status");
      render(<TodoListPage />);
      await screen.findByRole("dialog", { name: "Scheduled runs" });
      await waitFor(() => expect(hosting).toHaveBeenCalled());
      expect(schedules).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("binds native completion, confirmed deletion and successful draft save to the existing services", async () => {
    mocks.native = true;
    mocks.events = [];
    const task = buildTodo({ title: "Synthetic native task", type: "manual", date: null, time: null, notes: null });
    const remaining = buildTodo({ id: "pending-other", title: "Other pending task" });
    vi.mocked(TodoListPkmService.load).mockResolvedValue({ tasks: [task, remaining] });
    vi.spyOn(TodoListPkmService, "setStatus").mockResolvedValue({ success: true, saveState: "saved", fullBlob: {} });
    const create = vi.spyOn(todoService, "createTodo")
      .mockRejectedValueOnce(new Error("Synthetic save failure"))
      .mockResolvedValue({ task: { ...task, id: "created" }, result: { success: true, saveState: "saved", fullBlob: {} } });
    render(<TodoListPage />);
    const tap = async (label: string) => {
      const state = mocks.workspace!;
      const row = state.content.sections.flatMap(section => section.rows).find(row => row.label === label);
      expect(row, label).toBeDefined();
      await act(async () => { await state.actions.get(row!.id)!({} as never); });
    };
    await waitFor(() => expect(mocks.workspace?.content.sections.flatMap(section => section.rows).some(row => row.label === task.title)).toBe(true));
    await tap(task.title);
    await tap("Mark as completed");
    expect(TodoListPkmService.setStatus).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ task, status: "done" }));
    await tap("Completed");
    await tap(task.title);
    await tap("Delete item");
    await tap("Cancel");
    expect(TodoListPkmService.remove).not.toHaveBeenCalled();
    await tap("Delete item");
    await tap("Delete");
    expect(TodoListPkmService.remove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ task: expect.objectContaining({ id: task.id }) }));
    await waitFor(() => expect(mocks.workspace!.content.sections.flatMap(section => section.rows).some(row => row.label === remaining.title)).toBe(true));
    await tap("Add item");
    await act(async () => { expect(mocks.workspace!.editor!.changeDraft({ title: " Native draft ", date: "2026-11-05", time: "09:15", notes: " detail " } as never)).toBe(true); });
    await act(async () => { expect(await mocks.workspace!.editor!.save()).toBe(false); });
    expect(mocks.workspace!.editor!.current()).toBe(true);
    await act(async () => { const editor = mocks.workspace!.editor!; expect(await editor.save()).toBe(true); editor.onSaved(); });
    expect(create).toHaveBeenLastCalledWith({ title: "Native draft", type: "manual", date: "2026-11-05", time: "09:15", notes: "detail" }, expect.any(Object));
    expect(mocks.workspace!.editor).toBeUndefined();
  });

  it("preserves the native draft in complete React fallback and rejects late edits after Cancel", async () => {
    mocks.native = true;
    mocks.events = [];
    const view = render(<TodoListPage />);
    await waitFor(() => expect(mocks.workspace?.content.sections.flatMap(section => section.rows).find(row => row.label === "Add item")?.enabled).toBe(true));
    const row = mocks.workspace!.content.sections.flatMap(section => section.rows).find(row => row.label === "Add item")!;
    await act(async () => { await mocks.workspace!.actions.get(row.id)!({} as never); });
    const editor = mocks.workspace!.editor!;
    const draft = { title: "Retained native draft", date: "2026-11-05", time: "09:15", notes: "Retained notes" };
    await act(async () => { expect(editor.changeDraft(draft as never)).toBe(true); });
    mocks.nativeFailed = true;
    view.rerender(<TodoListPage />);
    expect(await screen.findByPlaceholderText("What do you want to do?")).toHaveValue(draft.title);
    expect(screen.getByLabelText("Date")).toHaveValue(draft.date);
    expect(screen.getByLabelText("Time")).toHaveValue(draft.time);
    expect(screen.getByLabelText("Notes")).toHaveValue(draft.notes);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(editor.current()).toBe(false);
    expect(editor.changeDraft({ ...draft, title: "Late old editor" } as never)).toBe(false);
  });

  it("rejects duplicate native writes while allowing an independent draft", async () => {
    mocks.native = true;
    mocks.events = [];
    const task = buildTodo({ id: "native-duplicate", title: "Native duplicate" });
    vi.mocked(TodoListPkmService.load).mockResolvedValue({ tasks: [task] });
    const write = deferredWrite();
    vi.spyOn(TodoListPkmService, "setStatus").mockReturnValue(write.promise);
    render(<TodoListPage />);
    await waitFor(() => expect(mocks.workspace?.content.sections.flatMap(section => section.rows).some(row => row.label === task.title)).toBe(true));
    const taskRow = mocks.workspace!.content.sections.flatMap(section => section.rows).find(row => row.label === task.title)!;
    await act(async () => { await mocks.workspace!.actions.get(taskRow.id)!({} as never); });
    const detail = mocks.workspace!;
    const done = detail.content.sections.flatMap(section => section.rows).find(row => row.label === "Mark as completed")!;
    act(() => { expect(detail.actions.get(done.id)!({} as never)).toBeUndefined(); expect(detail.actions.get(done.id)!({} as never)).toBeUndefined(); });
    expect(TodoListPkmService.setStatus).toHaveBeenCalledTimes(1);
    const add = mocks.workspace!.content.sections.flatMap(section => section.rows).find(row => row.label === "Add item")!;
    expect(add.enabled).toBe(true);
    await act(async () => { await mocks.workspace!.actions.get(add.id)!({} as never); });
    await act(async () => { expect(mocks.workspace!.editor!.changeDraft({ title: "Independent draft", date: "", time: "", notes: "" } as never)).toBe(true); });
    await act(async () => { write.resolve({ success: true, saveState: "saved", fullBlob: {} }); });
  });

  it("allows native manual input while an optional provider read remains pending", async () => {
    mocks.native = true;
    mocks.events = [];
    mocks.feedLoading = true;
    render(<TodoListPage />);
    await waitFor(() => expect(mocks.workspace?.content.sections.flatMap(section => section.rows).some(row => row.label === "Loading your list…")).toBe(true));
    const state = mocks.workspace!;
    const add = state.content.sections.flatMap(section => section.rows).find(row => row.label === "Add item")!;
    expect(add.enabled).toBe(true);
    await act(async () => { await state.actions.get(add.id)!({} as never); });
    expect(mocks.workspace!.editor).toBeDefined();
  });

  it.each(["wallet", "messages", "ria", "pkm"] as const)("reports unavailable selected %s reads instead of claiming no pending work", async capability => {
    mocks.events = [];
    vi.mocked(TodoListPkmService.load).mockResolvedValue({ tasks: [], selectedCapabilities: [capability] });
    mocks.reads = [{ coverage: { capability, count: 0, status: "unavailable" }, evidence: [] }];
    const view = render(<TodoListPage />);
    expect(await screen.findByText("Some tasks couldn’t load.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "No tasks yet" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    expect(mocks.retrySources).toHaveBeenCalledOnce();
    mocks.reads = [{ coverage: { capability, count: 0, status: "ready" }, evidence: [] }];
    view.rerender(<TodoListPage />);
    expect(await screen.findByRole("heading", { name: "No tasks yet" })).toBeVisible();
    expect(screen.queryByText("Some tasks couldn’t load.")).not.toBeInTheDocument();
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
  it("shows Calendar and email tasks in the list without source controls or false partial-read errors", async () => {
    mocks.reads = [{ coverage: { capability: "gmail", count: 1, status: "incomplete" }, evidence: [{
      capability: "gmail", key: "mail:opaque", summary: "Meeting details", pendingTitle: "Reply to Saru: Meeting details", href: "/one/gmail",
    }] }];
    render(<TodoListPage />);
    expect(await screen.findByText("Reply to Saru: Meeting details")).toBeVisible();
    expect(screen.getByText("Review the plan")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Reply to Saru: Meeting details" })).toHaveAttribute("href", "/one/gmail");
    for (const text of ["Suggest tasks", "Refresh sources", "Email tasks couldn’t load."]) {
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    }
  });
  it("keeps existing tasks visible when email fails and exposes a bounded retry", async () => {
    mocks.mailError = "private provider diagnostic";
    render(<TodoListPage />);
    expect(await screen.findByText("Email tasks couldn’t load.")).toBeVisible();
    expect(screen.getByText("Review the plan")).toBeVisible();
    expect(screen.queryByText("private provider diagnostic")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    expect(mocks.retrySources).toHaveBeenCalledOnce();
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

  it("preserves existing tasks during background refresh instead of wiping them to empty", async () => {
    const task = buildTodo({ id: "task-keep", title: "Existing task to keep", type: "manual" });
    vi.mocked(TodoListPkmService.load).mockResolvedValueOnce({ tasks: [task] });
    render(<TodoListPage />);
    expect(await screen.findByText("Existing task to keep")).toBeVisible();

    let resolveLoad!: (val: { tasks: TodoItem[] }) => void;
    vi.mocked(TodoListPkmService.load).mockReturnValueOnce(new Promise((res) => { resolveLoad = res; }));
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Existing task to keep")).toBeVisible();
    await act(async () => {
      resolveLoad({ tasks: [task] });
    });
    expect(screen.getByText("Existing task to keep")).toBeVisible();
  });

  it.each(["pending", "done"] as const)("keeps a %s reviewed email task tied to its source without duplicating it", status => {
    const saved = { ...buildTodo({ id: "suggested_mail:opaque", title: "Review the meeting reply", type: "manual", source: "gmail", sourceId: "mail:opaque", link: "/one/gmail" }), status };
    mocks.reads = [{ coverage: { capability: "gmail", count: 1, status: "incomplete" }, evidence: [{
      capability: "gmail", key: "mail:opaque", summary: "Meeting reply", pendingTitle: "Reply: Meeting reply", href: "/one/gmail",
    }] }];
    const { result } = renderHook(() => useTodoLiveTasks({ userId: "todo-owner", vaultOwnerToken: "fixture", idTokenProvider: async () => "fixture-id", enabled: true, tasks: [saved] }));
    expect(result.current.pending.filter(task => task.sourceAgent === "gmail")).toHaveLength(status === "pending" ? 1 : 0);
    if (status === "pending") expect(result.current.evidence.find(item => item.key === "mail:opaque")).toMatchObject({ capability: "gmail", pendingTitle: saved.title });
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

  it.each([
    { status: "cancelled", start: { date: "2026-10-10" } },
    { status: "CANCELLED", start: null },
    { status: "cancelled", start: null, id: `event-${"a".repeat(250)}` },
  ])("honors explicit Calendar cancellation without hiding unrelated tasks: %j", (cancellation) => {
    const event = { ...mocks.events[0]!, id: cancellation.id ?? "calendar-event-1" };
    mocks.events = [event];
    const cancelled = buildTodo(todoService.calendarTodoInput(event)!);
    const unrelated = buildTodo(todoService.calendarTodoInput({ ...event, id: "calendar-event-2" })!);
    const gmail = buildTodo(todoService.gmailTodoInput({ id: event.id!, title: "Email follow-up" })!);
    const manual = buildTodo({ type: "manual", title: "Owner task", sourceId: event.id });
    let tasks = [cancelled, unrelated, manual];
    const { result, rerender } = renderHook(() => useTodoLiveTasks({
      userId: mocks.user.uid, vaultOwnerToken: "test-owner-token",
      idTokenProvider: mocks.user.getIdToken, enabled: true, tasks,
    }));
    expect(result.current.pending.some(task => task.id === cancelled.id)).toBe(true);

    mocks.events = [{ ...event, ...cancellation, title: "" }];
    rerender();

    expect(result.current.pending.map(task => task.id).sort()).toEqual(
      [unrelated.id, manual.id].sort(),
    );
    expect(cancelled.status).toBe("pending");

    tasks = [...tasks, gmail];
    mocks.events = [...mocks.events, event];
    rerender();
    expect(result.current.pending.map(task => task.id).sort()).toEqual(
      [unrelated.id, gmail.id, manual.id].sort(),
    );
  });

  it("keeps saved Calendar snapshots when a read omits events or cannot identify a cancellation", () => {
    const saved = buildTodo(todoService.calendarTodoInput(mocks.events[0]!)!);
    const done = { ...saved, id: "calendar-done", sourceId: "done", status: "done" as const };
    const deleted = { ...saved, id: "calendar-deleted", sourceId: "deleted", status: "deleted" as const };
    mocks.events = [];
    const { result, rerender } = renderHook(() => useTodoLiveTasks({
      userId: mocks.user.uid, vaultOwnerToken: "test-owner-token",
      idTokenProvider: mocks.user.getIdToken, enabled: true, tasks: [saved, done, deleted],
    }));
    expect(result.current.pending).toEqual([saved]);

    mocks.events = [{ id: null, title: saved.title, start: null, end: null, status: "cancelled" }];
    rerender();
    expect(result.current.pending).toEqual([saved]);
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

  it.each([true, false])("keeps independent task writes busy until each settles (first fails: %s)", async firstFails => {
    const other = buildTodo({ id: "parallel-task", title: "Parallel task" });
    vi.mocked(TodoListPkmService.load).mockResolvedValue({ tasks: [other] });
    const first = deferredWrite(), second = deferredWrite();
    vi.spyOn(TodoListPkmService, "setStatus")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(<TodoListPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Mark Review the plan as completed" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Mark Parallel task as completed" }));
    fireEvent.click(screen.getByRole("button", { name: /^Completed/ }));

    expect(screen.getByRole("button", { name: "Delete Review the plan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Parallel task" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete Review the plan" }));
    expect(TodoListPkmService.remove).not.toHaveBeenCalled();

    await act(async () => { first.resolve({ success: !firstFails, saveState: firstFails ? "failed" : "saved", fullBlob: {} }); });
    expect(screen.getByRole("button", { name: "Delete Parallel task" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Review the plan" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete Review the plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete", exact: true }));
    await waitFor(() => expect(TodoListPkmService.remove).toHaveBeenCalledOnce());
    await act(async () => { second.resolve({ success: firstFails, saveState: firstFails ? "saved" : "failed", fullBlob: {} }); });
    expect(screen.queryByText("Review the plan")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Parallel task" })).toBeEnabled();
  });

  it("does not collect live sources until saved source choices can be verified", async () => {
    const save = vi.spyOn(TodoListPkmService, "setStatus");
    vi.mocked(TodoListPkmService.load).mockRejectedValueOnce(new Error("offline"));
    render(<TodoListPage />);
    await screen.findByText("Your saved items couldn’t load.");
    expect(screen.queryByText("Review the plan")).not.toBeInTheDocument();
    const task = buildTodo(todoService.calendarTodoInput(mocks.events[0]!)!);
    vi.mocked(TodoListPkmService.load).mockResolvedValue({ tasks: [{ ...task, status: "deleted" }], selectedCapabilities: [] });
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    await waitFor(() => expect(screen.queryByText("Your saved items couldn’t load.")).not.toBeInTheDocument());
    expect(screen.queryByText("Review the plan")).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(TodoListPkmService.remove).not.toHaveBeenCalled();
  });

  it.each(["manual", "automatic"] as const)("restores a %s task when deletion fails", async type => {
    mocks.events = [];
    const task = buildTodo({ id: `delete-failure-${type}`, title: "Retain failed deletion", type });
    vi.mocked(TodoListPkmService.load).mockResolvedValue({ tasks: [task] });
    const write = deferredWrite();
    vi.mocked(TodoListPkmService.remove).mockImplementation(() => write.promise);
    render(<TodoListPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Retain failed deletion" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete", exact: true }));
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    await act(async () => { write.resolve({ success: false, saveState: "failed", fullBlob: {} }); });
    expect(await screen.findByRole("checkbox", { name: "Mark Retain failed deletion as completed" })).toHaveAttribute("aria-checked", "false");
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

  it("dismisses detail view and returns to the to-do list when marking a task as completed", async () => {
    render(<TodoListPage />);
    const taskButton = await screen.findByRole("button", { name: "Review the plan", exact: true });
    await act(async () => {
      fireEvent.click(taskButton);
    });
    const detail = screen.getByRole("region", { name: "Task details" });
    expect(detail).toBeVisible();
    await act(async () => {
      fireEvent.click(within(detail).getByRole("button", { name: "Mark as completed", exact: true }));
    });
    expect(screen.queryByRole("region", { name: "Task details" })).not.toBeInTheDocument();
  });

  it("allows typing and saving in the task composer while a background task write is in flight", async () => {
    let finishWrite!: (result: { success: boolean; saveState: string; fullBlob: object }) => void;
    vi.spyOn(TodoListPkmService, "setStatus").mockImplementationOnce(
      () => new Promise((resolve) => { finishWrite = resolve; }),
    );
    vi.spyOn(todoService, "createTodo").mockResolvedValueOnce({
      task: buildTodo({ id: "new-task-1", title: "New created item", type: "manual" }),
      result: { success: true },
    });

    render(<TodoListPage />);
    const checkbox = await screen.findByRole("checkbox", {
      name: "Mark Review the plan as completed",
    });
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    const titleInput = screen.getByRole("textbox", { name: "Title", exact: true });
    expect(titleInput).toBeEnabled();
    fireEvent.change(titleInput, { target: { value: "New created item" } });
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));

    await waitFor(() => {
      expect(todoService.createTodo).toHaveBeenCalledWith(
        expect.objectContaining({ title: "New created item" }),
        expect.anything(),
      );
    });

    await act(async () => {
      finishWrite({ success: true, saveState: "saved", fullBlob: {} });
    });
  });
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TodoListPage } from "@/components/todos/todo-list-page";
import {
  TodoListPkmService,
  buildTodo,
} from "@/lib/services/todo-list-pkm-service";

const mocks = vi.hoisted(() => ({
  user: { uid: "todo-owner", getIdToken: vi.fn() },
  events: [
    {
      id: "calendar-event-1",
      title: "Review the plan",
      start: { date: "2026-10-10" },
    },
  ],
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
    vaultKey: "test-vault-key",
    vaultOwnerToken: "test-owner-token",
  }),
}));

vi.mock("@/lib/calendar/use-calendar-connection-status", () => ({
  useCalendarConnectionStatus: () => ({ connected: true }),
}));

vi.mock("@/lib/calendar/use-calendar-upcoming-events", () => ({
  useCalendarUpcomingEvents: () => ({ events: mocks.events }),
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
    vi.spyOn(TodoListPkmService, "load").mockResolvedValue({ tasks: [] });
    vi.spyOn(TodoListPkmService, "remove").mockResolvedValue({
      success: true,
      saveState: "saved",
      fullBlob: {},
    });
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
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoalsWorkspace } from "@/components/goals/goals-workspace";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import type { TodoItem } from "@/lib/todos/todo-list-model";

const mocks = vi.hoisted(() => ({
  owner: "owner-a",
  unlocked: true,
  loadWorkspace: vi.fn(),
  create: vi.fn(),
  savePlan: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: mocks.owner }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({
  isVaultUnlocked: mocks.unlocked, vaultKey: "test-key", vaultOwnerToken: "test-token",
}) }));
vi.mock("@/lib/pkm/use-pkm-domain-change-revision", () => ({ usePkmDomainChangeRevision: () => 0 }));
vi.mock("@/lib/services/goals-pkm-service", () => ({ GoalsPkmService: mocks }));
vi.mock("@/lib/services/todo-list-pkm-service", () => ({ TODO_LIST_PKM_DOMAIN: "one_todos" }));

const task: TodoItem = {
  id: "task-a", title: "Draft agenda", type: "manual", date: null, time: null,
  status: "done", sourceAgent: null, sourceId: null, link: null, notes: null,
  createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z",
  completedAt: "2026-11-18T00:00:00.000Z", deletedAt: null, revision: 1,
};
const goal = {
  id: "goal-a", title: "Plan launch", outcome: "The agenda is approved", category: null,
  status: "active", taskIds: [task.id], revision: 1, createdAt: task.createdAt,
  updatedAt: task.updatedAt, completedAt: null, deletedAt: null,
};

describe("Goals workspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.owner = "owner-a";
    mocks.unlocked = true;
    mocks.loadWorkspace.mockResolvedValue({ goals: [], tasks: [task] });
  });

  it("retains a failed draft and reuses its identity when the owner retries", async () => {
    mocks.create.mockResolvedValueOnce({ result: { success: false } })
      .mockImplementationOnce(async () => {
        mocks.loadWorkspace.mockResolvedValue({ goals: [goal], tasks: [task] });
        return { goalId: goal.id, result: { success: true } };
      });
    render(<GoalsWorkspace />);
    await screen.findByText("No goals yet");
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));
    fireEvent.change(screen.getByLabelText("Goal name"), { target: { value: goal.title } });
    fireEvent.change(screen.getByLabelText("What would success look like?"), { target: { value: goal.outcome } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Draft agenda/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Goal name")).toHaveValue(goal.title);
    expect(screen.getByRole("checkbox", { name: /Draft agenda/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
    await screen.findByRole("button", { name: "Edit goal" });
    const first = mocks.create.mock.calls[0];
    expect(first?.[0]).toMatchObject({ taskIds: [task.id] });
    expect(first?.[1]).toMatchObject({ confirmedByUser: true, draftId: expect.any(String) });
    expect(mocks.create.mock.calls[1]?.[1].draftId).toBe(first?.[1].draftId);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("unwinds the editor before detail and clears planning information on lock", async () => {
    mocks.loadWorkspace.mockResolvedValue({ goals: [goal], tasks: [task] });
    const view = render(<GoalsWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: /Plan launch/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
    fireEvent.change(screen.getByLabelText("Goal name"), { target: { value: "Private unsaved edit" } });
    act(() => { expect(unwindBackLayer("/one/goals")).toBe(true); });
    expect(screen.getByRole("button", { name: "Edit goal" })).toBeVisible();
    act(() => { expect(unwindBackLayer("/one/goals")).toBe(true); });
    expect(screen.getByRole("button", { name: /Plan launch/ })).toBeVisible();
    act(() => { expect(unwindBackLayer("/one/goals")).toBe(false); });
    expect(mocks.savePlan).not.toHaveBeenCalled();

    mocks.unlocked = false;
    view.rerender(<GoalsWorkspace />);
    expect(screen.getByText(/Unlock your vault/)).toBeVisible();
    expect(screen.queryByText(goal.title)).not.toBeInTheDocument();
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TodoAgentSuggestions } from "@/components/todos/todo-agent-suggestions";
import { createTodo } from "@/lib/services/todo-list-pkm-service";
import { suggestTodoTasks, todoSuggestionsAvailable } from "@/lib/services/todo-suggestion-service";
import type { TaskSuggestion } from "@/lib/todos/task-suggestion-model";

vi.mock("@/lib/services/todo-suggestion-service", () => ({ suggestTodoTasks: vi.fn(), todoSuggestionsAvailable: vi.fn() }));
vi.mock("@/lib/services/todo-list-pkm-service", () => ({ createTodo: vi.fn() }));
const item = { key: "meeting", capability: "calendar" as const, title: "Prepare meeting notes", reason: "A team meeting is coming up.", href: "/one/calendar" };
const props = () => ({ userId: "owner", vaultKey: "fixture-key", vaultOwnerToken: "fixture-token", evidence: [{ key: "meeting", capability: "calendar" as const, summary: "An upcoming team meeting", href: "/one/calendar" }], coverage: [], loading: false, onRefresh: vi.fn(), onSaved: vi.fn() });
async function approve() {
  const checkbox = screen.getByRole("checkbox", { name: "Use my task summaries with One to suggest next steps." });
  await waitFor(() => expect(checkbox).toBeEnabled());
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Suggest tasks" }));
}
describe("agentic To-do review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(todoSuggestionsAvailable).mockResolvedValue(true);
    vi.mocked(suggestTodoTasks).mockResolvedValue([item]);
    vi.mocked(createTodo).mockResolvedValue({ task: {} as never, result: { success: true, saveState: "saved", fullBlob: {} } });
  });
  it("shows all nine catalog capabilities and never infers or saves on mount", async () => {
    render(<TodoAgentSuggestions {...props()} />);
    fireEvent.click(screen.getByText("Task sources"));
    for (const title of ["Messages", "Finance", "Wallet", "Location", "Advisor", "Mail", "Calendar", "Memory", "Consent"]) expect(screen.getByText(title)).toBeVisible();
    expect(screen.getByRole("button", { name: "Suggest tasks" })).toBeDisabled();
    expect(suggestTodoTasks).not.toHaveBeenCalled();
    expect(createTodo).not.toHaveBeenCalled();
  });
  it("requires processing approval, then a separate Add before encrypted persistence", async () => {
    const input = props();
    render(<TodoAgentSuggestions {...input} />);
    await approve();
    expect(await screen.findByText(item.title)).toBeVisible();
    expect(createTodo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() => expect(input.onSaved).toHaveBeenCalledOnce());
    expect(createTodo).toHaveBeenCalledWith({ title: item.title, notes: item.reason, link: item.href, type: "manual" }, { userId: "owner", vaultKey: "fixture-key", vaultOwnerToken: "fixture-token" });
  });
  it("keeps an unsuccessfully saved suggestion available to retry", async () => {
    vi.mocked(createTodo).mockResolvedValue({ task: {} as never, result: { success: false, saveState: "error", fullBlob: {} } });
    render(<TodoAgentSuggestions {...props()} />);
    await approve();
    fireEvent.click(await screen.findByRole("button", { name: "Add task" }));
    expect(await screen.findByText("Task could not be saved. Try again.")).toBeVisible();
    expect(screen.getByText(item.title)).toBeVisible();
  });
  it("drops late suggestions when owner or source evidence changes", async () => {
    let resolve!: (value: TaskSuggestion[]) => void;
    vi.mocked(suggestTodoTasks).mockReturnValue(new Promise(r => { resolve = r; }));
    const input = props();
    const view = render(<TodoAgentSuggestions {...input} />);
    await approve();
    view.rerender(<TodoAgentSuggestions {...input} userId="new-owner" evidence={[]} />);
    await act(async () => resolve([item]));
    expect(screen.queryByText(item.title)).not.toBeInTheDocument();
    expect(createTodo).not.toHaveBeenCalled();
  });
  it("keeps the suggestion action unavailable when the runtime feature is off", async () => {
    vi.mocked(todoSuggestionsAvailable).mockResolvedValue(false);
    render(<TodoAgentSuggestions {...props()} />);
    expect(await screen.findByText("Task suggestions are not available on this agent yet.")).toBeVisible();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(suggestTodoTasks).not.toHaveBeenCalled();
  });
});

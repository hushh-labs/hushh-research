import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/todo-list-pkm-service", () => ({
  createTodo: vi.fn(),
  gmailTodoInput: vi.fn(),
}));

import { runGmailTodoDirective } from "@/lib/agent/gmail-todo-directive-runtime";
import {
  createTodo,
  gmailTodoInput,
} from "@/lib/services/todo-list-pkm-service";

const directive = {
  kind: "action" as const,
  payload: {
    type: "gmail.create_todos",
    proposalId: "gmail_todo_opaque",
    todos: [{ id: "gmail_todo_opaque:1", title: "Follow up: Project plan" }],
  },
};

describe("runGmailTodoDirective", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes only the confirmed opaque Gmail follow-up to the private list", async () => {
    vi.mocked(gmailTodoInput).mockReturnValue({
      id: "gmail_gmail_todo_opaque:1",
      title: "Follow up: Project plan",
      type: "automatic",
      source: "gmail",
      sourceId: "gmail_todo_opaque:1",
    });
    vi.mocked(createTodo).mockResolvedValue({
      task: {} as never,
      result: { success: true, saveState: "saved", fullBlob: {} },
    });

    await expect(
      runGmailTodoDirective(directive, "owner-1", "vault-key", "HCT:test"),
    ).resolves.toMatchObject({
      delegate_agent_id: "agent_email",
      status: "completed",
      detail: "Added the email follow-up to your To-do list.",
    });

    expect(gmailTodoInput).toHaveBeenCalledWith({
      id: "gmail_todo_opaque:1",
      title: "Follow up: Project plan",
    });
    expect(createTodo).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "gmail",
        sourceId: "gmail_todo_opaque:1",
      }),
      {
        userId: "owner-1",
        vaultKey: "vault-key",
        vaultOwnerToken: "HCT:test",
      },
    );
  });

  it("rejects a directive without the server-issued todo shape", async () => {
    await expect(
      runGmailTodoDirective(
        {
          kind: "action",
          payload: {
            type: "gmail.create_todos",
            proposalId: "gmail_todo_opaque",
            todos: [
              { id: "duplicate", title: "one" },
              { id: "duplicate", title: "two" },
            ],
          },
        },
        "owner-1",
        "vault-key",
        "HCT:test",
      ),
    ).rejects.toThrow("Gmail follow-up is no longer available");
    expect(createTodo).not.toHaveBeenCalled();
  });

  it("rejects a proposal item that does not belong to its server proposal", async () => {
    await expect(
      runGmailTodoDirective(
        {
          kind: "action",
          payload: {
            type: "gmail.create_todos",
            proposalId: "gmail_todo_current",
            todos: [
              {
                id: "gmail_todo_other:1",
                title: "Follow up: Project plan",
              },
            ],
          },
        },
        "owner-1",
        "vault-key",
        "HCT:test",
      ),
    ).rejects.toThrow("Gmail follow-up is no longer available");
    expect(createTodo).not.toHaveBeenCalled();
  });
});

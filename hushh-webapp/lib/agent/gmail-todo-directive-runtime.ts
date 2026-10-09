import type {
  DelegateResult,
  SpecialistDirective,
} from "@/lib/agent/specialist-directive-runtime";
import {
  createTodo,
  gmailTodoInput,
} from "@/lib/services/todo-list-pkm-service";

type GmailTodoDirectiveItem = {
  id: string;
  title: string;
};

function directiveItems(
  payload: Record<string, unknown>,
): GmailTodoDirectiveItem[] {
  if (
    !Array.isArray(payload.todos) ||
    payload.todos.length === 0 ||
    payload.todos.length > 10
  ) {
    return [];
  }
  const seen = new Set<string>();
  const items: GmailTodoDirectiveItem[] = [];
  for (const raw of payload.todos) {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (
      !id ||
      id.length > 240 ||
      !title ||
      title.length > 240 ||
      seen.has(id)
    ) {
      return [];
    }
    seen.add(id);
    items.push({ id, title });
  }
  return items;
}

/**
 * Save the exact owner-confirmed Gmail follow-ups that the server resolved.
 * The Gmail message ids remain server-side; only the safe title and opaque
 * proposal item id enter the encrypted private To-do record.
 */
export async function runGmailTodoDirective(
  directive: SpecialistDirective,
  userId: string,
  vaultKey: string,
  vaultOwnerToken: string,
): Promise<DelegateResult> {
  const payload = directive.payload as Record<string, unknown>;
  const proposalId =
    typeof payload.proposalId === "string" ? payload.proposalId.trim() : "";
  const items = directiveItems(payload);
  if (
    payload.type !== "gmail.create_todos" ||
    !proposalId ||
    proposalId.length > 240 ||
    !items.length ||
    items.some((item) => !item.id.startsWith(`${proposalId}:`))
  ) {
    throw new Error("That Gmail follow-up is no longer available.");
  }

  for (const item of items) {
    const todo = gmailTodoInput(item);
    if (!todo) throw new Error("That Gmail follow-up is no longer available.");
    const saved = await createTodo(todo, { userId, vaultKey, vaultOwnerToken });
    if (!saved.result.success) {
      throw new Error("The item couldn’t be saved. Try again.");
    }
  }

  return {
    delegate_agent_id: "agent_email",
    kind: "action",
    id: proposalId,
    type: "gmail.create_todos",
    status: "completed",
    detail: `Added ${items.length === 1 ? "the email follow-up" : `${items.length} email follow-ups`} to your To-do list.`,
  };
}

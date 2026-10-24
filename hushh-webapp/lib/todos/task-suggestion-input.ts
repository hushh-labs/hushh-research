import type { CreateTodoInput } from "@/lib/services/todo-list-pkm-service";
import type { TaskSuggestion } from "./task-suggestion-model";

/** Stable identity makes repeated reviewed Add operations idempotent. */
export async function taskSuggestionInput(item: TaskSuggestion): Promise<CreateTodoInput> {
  if (!item.key || item.key.length > 240) throw new Error("Invalid task source identity");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${item.capability}:${item.key}`));
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  return {
    id: `suggested_${hash}`, title: item.title, notes: item.reason,
    link: item.href, type: "manual", sourceId: item.key,
    source: item.capability === "finance" ? "kai" : item.capability,
  };
}

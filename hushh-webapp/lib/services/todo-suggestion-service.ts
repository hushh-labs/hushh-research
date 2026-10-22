import { apiJson } from "@/lib/services/api-client";
import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";
import { normalizeInternalRouteHref } from "@/lib/navigation/routes";
import { taskSuggestionSchema, type TaskEvidence, type TaskSuggestion } from "@/lib/todos/task-suggestion-model";

export async function todoSuggestionsAvailable(vaultOwnerToken: string, signal: AbortSignal): Promise<boolean> {
  if (await ownerContentIsPrivate()) return false;
  const result = await apiJson<{ available?: unknown }>("/api/one/todos/suggestions/status", { method: "GET", cache: "no-store", signal, headers: { Authorization: `Bearer ${vaultOwnerToken}` } });
  return result.available === true;
}

export async function suggestTodoTasks(input: {
  vaultOwnerToken: string;
  sources: TaskEvidence[];
  allowModelProcessing: true;
  signal?: AbortSignal;
  isCurrent: () => boolean;
}): Promise<TaskSuggestion[]> {
  // The hub must never become a fallback for a private owner's content.
  if (await ownerContentIsPrivate()) throw new Error("Open your private agent to ask for task suggestions.");
  if (!input.isCurrent()) throw new DOMException("Session changed", "AbortError");
  const sources = [...new Map(input.sources.map(source => [source.key, source])).values()].slice(0, 100);
  if (!sources.length) return [];
  const offered = new Map(sources.map((source, index) => [`s${index + 1}`, source]));
  const payload = await apiJson<unknown>("/api/one/todos/suggestions", {
    method: "POST", cache: "no-store", signal: input.signal,
    headers: { Authorization: `Bearer ${input.vaultOwnerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ allow_model_processing: input.allowModelProcessing,
      sources: [...offered].map(([ref, source]) => ({ ref, capability: source.capability, summary: source.summary, already_pending: Boolean(source.pendingTitle) })) }),
    isEffectCurrent: input.isCurrent,
  });
  if (!input.isCurrent()) throw new DOMException("Session changed", "AbortError");
  const result = taskSuggestionSchema.parse(payload);
  const selected = new Set<string>();
  return result.items.map(item => {
    const source = offered.get(item.source_ref);
    const href = source && normalizeInternalRouteHref(source.href);
    if (!source || !href || selected.has(item.source_ref)) throw new Error("Task suggestions could not be verified.");
    selected.add(item.source_ref);
    return { key: source.key, capability: source.capability, title: item.title, reason: item.reason, href };
  });
}

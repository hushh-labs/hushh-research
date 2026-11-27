import { apiJson } from "@/lib/services/api-client";
import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";
import { normalizeInternalRouteHref } from "@/lib/navigation/routes";
import { taskSuggestionSchema, type TaskCapability, type TaskEvidence, type TaskSuggestion } from "@/lib/todos/task-suggestion-model";

async function requestSuggestions<T>(path: string, token: string, init: RequestInit, isCurrent: () => boolean): Promise<T> {
  if (!isCurrent()) throw new DOMException("Session changed", "AbortError");
  const privateOwner = await ownerContentIsPrivate();
  if (!isCurrent()) throw new DOMException("Session changed", "AbortError");
  if (!privateOwner) return apiJson<T>(`/api/one/todos/${path}`, {
    ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, isEffectCurrent: isCurrent,
  });
  const { ApiService } = await import("@/lib/services/api-service");
  const response = await ApiService.ownerPodRequest(`todos/${path}`, init, false, undefined, undefined, isCurrent);
  if (!response.ok) throw new Error("Task suggestions are unavailable in your private agent.");
  return response.json() as Promise<T>;
}

export async function todoSuggestionsAvailable(vaultOwnerToken: string, signal: AbortSignal): Promise<boolean> {
  const result = await requestSuggestions<{ available?: unknown }>("suggestions/status", vaultOwnerToken, { method: "GET", cache: "no-store", signal }, () => !signal.aborted);
  return result.available === true;
}

/** Bound input structurally without letting one large queue hide other capabilities. */
function balancedSources(evidence: TaskEvidence[]): TaskEvidence[] {
  const buckets = new Map<TaskEvidence["capability"], TaskEvidence[]>();
  for (const source of new Map(evidence.map(item => [item.key, item])).values()) {
    const bucket = buckets.get(source.capability) ?? [];
    bucket.push(source);
    buckets.set(source.capability, bucket);
  }
  const selected: TaskEvidence[] = [];
  for (let index = 0; selected.length < 100; index += 1) {
    const next = [...buckets.values()].flatMap(bucket => bucket[index] ? [bucket[index]!] : []);
    if (!next.length) break;
    selected.push(...next.slice(0, 100 - selected.length));
  }
  return selected;
}

export async function suggestTodoTasks(input: {
  vaultOwnerToken: string;
  sources: TaskEvidence[];
  selectedCapabilities?: readonly TaskCapability[];
  allowModelProcessing: true;
  signal?: AbortSignal;
  isCurrent: () => boolean;
}): Promise<TaskSuggestion[]> {
  if (!input.isCurrent()) throw new DOMException("Session changed", "AbortError");
  const sources = balancedSources(input.sources.filter(source => !source.pendingTitle && (!input.selectedCapabilities || input.selectedCapabilities.includes(source.capability))));
  if (!sources.length) throw new Error("No task summaries are available to assess.");
  const offered = new Map(sources.map((source, index) => [`s${index + 1}`, source]));
  const payload = await requestSuggestions<unknown>("suggestions", input.vaultOwnerToken, {
    method: "POST", cache: "no-store", signal: input.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allow_model_processing: input.allowModelProcessing,
      ...(input.selectedCapabilities === undefined ? {} : { selected_capabilities: input.selectedCapabilities }),
      sources: [...offered].map(([ref, source]) => ({ ref, capability: source.capability, summary: source.summary, already_pending: Boolean(source.pendingTitle) })) }),
  }, input.isCurrent);
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

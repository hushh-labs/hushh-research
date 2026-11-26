import { parseSSEBlocks } from "../streaming/sse-parser";
import { boundedAgentEvents } from "../services/agent-event-boundary";
import { applyA2uiMessage, type A2uiSurfaces } from "./surface-store";

const ONE_ROOT = "one";
const A2UI_TOOL = "send_a2ui_json_to_client";
const NATIVE_ERROR_CODES = [
  "POD_CHAT_BUSY", "POD_CHAT_UPDATING", "AGENT_ERROR", "PUPPY_NOT_CONFIGURED",
  "PUPPY_SESSION_UNAVAILABLE", "PUPPY_KEY_REFUSED", "PUPPY_UNAVAILABLE",
] as const;
const NATIVE_EVENTS = new Set(["message", "start", "activity", "review", "done", "error", "browser_task"]);
type NativeErrorCode = typeof NATIVE_ERROR_CODES[number];

export type NativeBrowserTaskReceipt = {
  invocationId: string;
  toolCallId: string;
  status: "accepted";
  binding: { owner_id: string; task_id: string };
};
type BrowserTaskObserver = (receipt: NativeBrowserTaskReceipt, sessionId?: string) => void;

export type NativeAdkTurnOutput = {
  surfaces: A2uiSurfaces;
  settledText: string;
  partialText: string;
  status: "streaming" | "complete" | "awaiting_review" | "error";
  errorCode?: NativeErrorCode;
  sessionId?: string;
  serverMessageId?: string;
  activity?: string[];
};

export function createNativeAdkTurnOutput(): NativeAdkTurnOutput {
  return { surfaces: new Map(), settledText: "", partialText: "", status: "streaming" };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function browserTaskReceipt(value: unknown): NativeBrowserTaskReceipt | null {
  const payload = object(value);
  const binding = object(payload?.binding);
  const id = (candidate: unknown): candidate is string => typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(candidate);
  if (!payload || Object.keys(payload).sort().join(",") !== "binding,invocationId,status,toolCallId" ||
      !binding || Object.keys(binding).sort().join(",") !== "owner_id,task_id" ||
      payload.status !== "accepted" || !id(payload.invocationId) || !id(payload.toolCallId) ||
      typeof binding.owner_id !== "string" || !binding.owner_id || binding.owner_id.length > 256 ||
      typeof binding.task_id !== "string" || !/^browser_[a-f0-9]{32}$/.test(binding.task_id)) return null;
  return { invocationId: payload.invocationId, toolCallId: payload.toolCallId, status: "accepted",
    binding: { owner_id: binding.owner_id, task_id: binding.task_id } };
}

/** Consume one public projection from an admitted native ADK stream. */
function applyNativeAdkEvent(output: NativeAdkTurnOutput, value: unknown): NativeAdkTurnOutput {
  const event = object(value);
  if (event?.author !== ONE_ROOT) return output;
  const parts = object(event.content)?.parts;
  if (!Array.isArray(parts)) return output;
  const projected = parts.map(object).filter(part => part && part.thought !== true);
  const text = projected.map(part => typeof part?.text === "string" ? part.text : "").join("");
  if (event.partial === true) {
    return text ? { ...output, partialText: output.partialText + text } : output;
  }
  let surfaces = output.surfaces;
  for (const part of projected) {
    const response = object(part?.functionResponse);
    if (response?.name !== A2UI_TOOL) continue;
    const messages = object(response.response)?.validated_a2ui_json;
    if (!Array.isArray(messages) || messages.length > 24) continue;
    for (const message of messages) surfaces = applyA2uiMessage(surfaces, message);
  }
  if (!text && surfaces === output.surfaces) return output;
  if (!text) return { ...output, surfaces };
  // ADK's settled text is the aggregate from the model call. Replace its
  // provisional chunks instead of appending the same answer twice.
  const eventId = typeof event.id === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(event.id)
    ? event.id : undefined;
  return { ...output, surfaces, settledText: output.settledText + text, partialText: "", serverMessageId: eventId };
}

export function consumeNativeAdkFrames(
  output: NativeAdkTurnOutput, chunk: string, remainder = "",
  onBrowserTask?: BrowserTaskObserver,
): { output: NativeAdkTurnOutput; remainder: string } {
  const parsed = parseSSEBlocks(chunk, remainder, "message");
  let next = output;
  for (const { event, data } of parsed.events) {
    if (next.status !== "streaming") break;
    if (!NATIVE_EVENTS.has(event)) continue;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      // An invalid visual frame must leave the last good surface intact.
      continue;
    }
    if (event === "message") {
      next = applyNativeAdkEvent(next, value);
      continue;
    }
    const payload = object(value);
    if (!payload) continue;
    if (event === "browser_task") {
      const receipt = browserTaskReceipt(payload);
      if (receipt) onBrowserTask?.(receipt, next.sessionId);
      continue;
    }
    if (event === "start" && !next.sessionId && typeof payload.sessionId === "string" &&
        /^[A-Za-z0-9_.:-]{1,200}$/.test(payload.sessionId)) {
      next = { ...next, sessionId: payload.sessionId };
    } else if (event === "activity" && typeof payload.label === "string" &&
        /^[A-Za-z0-9_. -]{1,80}$/.test(payload.label) && (next.activity?.length ?? 0) < 32) {
      next = { ...next, activity: [...(next.activity ?? []), payload.label] };
    } else if (event === "done" && Object.keys(payload).length === 0) {
      next = { ...next, status: "complete", settledText: next.settledText + next.partialText, partialText: "" };
    } else if (event === "review" && Object.keys(payload).length === 0) {
      next = { ...next, status: "awaiting_review", partialText: "" };
    } else if (event === "error") {
      const errorCode = NATIVE_ERROR_CODES.find(code => code === payload.code) ?? "AGENT_ERROR";
      next = { ...next, status: "error", errorCode };
    }
  }
  return { output: next, remainder: parsed.remainder };
}

/** Read the common native turn projection with the app's existing SSE budgets. */
export async function readNativeAdkTurn(
  response: Response,
  onOutput: (turn: NativeAdkTurnOutput) => void,
  onBrowserTask?: BrowserTaskObserver,
): Promise<NativeAdkTurnOutput> {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.ok || type !== "text/event-stream" || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("AGENT_STREAM_PROTOCOL_UNSUPPORTED");
  }
  const reader = response.body.pipeThrough(boundedAgentEvents()).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let output = createNativeAdkTurnOutput();
  let remainder = "";
  try {
    while (output.status === "streaming") {
      const { value, done } = await reader.read();
      if (done) break;
      const next = consumeNativeAdkFrames(output, decoder.decode(value, { stream: true }), remainder, onBrowserTask);
      remainder = next.remainder;
      if (next.output !== output) {
        output = next.output;
        onOutput(output);
      }
    }
    if (output.status === "streaming") throw new Error("AGENT_STREAM_INCOMPLETE");
    return output;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

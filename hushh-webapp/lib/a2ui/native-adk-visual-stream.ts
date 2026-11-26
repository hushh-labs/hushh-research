import { parseSSEBlocks } from "../streaming/sse-parser";
import { boundedAgentEvents } from "../services/agent-event-boundary";
import { parseMainLocationProposal, type MainLocationProposal } from "../agent/main-chat-location-contract";
import { applyA2uiMessage, type A2uiSurfaces } from "./surface-store";

const ONE_ROOT = "one";
const A2UI_TOOL = "send_a2ui_json_to_client";
const NATIVE_ERROR_CODES = [
  "POD_CHAT_BUSY", "POD_CHAT_UPDATING", "AGENT_ERROR", "PUPPY_NOT_CONFIGURED",
  "PUPPY_SESSION_UNAVAILABLE", "PUPPY_KEY_REFUSED", "PUPPY_UNAVAILABLE",
] as const;
const NATIVE_EVENTS = new Set(["message", "start", "activity", "review", "done", "error"]);
type NativeErrorCode = typeof NATIVE_ERROR_CODES[number];

export type NativeAdkTurnOutput = {
  surfaces: A2uiSurfaces;
  settledText: string;
  partialText: string;
  status: "streaming" | "complete" | "awaiting_review" | "error";
  errorCode?: NativeErrorCode;
  sessionId?: string;
  serverMessageId?: string;
  activity?: string[];
  locationChatProposal?: MainLocationProposal;
};

export function createNativeAdkTurnOutput(): NativeAdkTurnOutput {
  return { surfaces: new Map(), settledText: "", partialText: "", status: "streaming" };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Consume one public projection from an admitted native ADK stream. */
function applyNativeAdkEvent(output: NativeAdkTurnOutput, value: unknown, locationChatReview: boolean): NativeAdkTurnOutput {
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
  let locationChatProposal = output.locationChatProposal;
  for (const part of projected) {
    const response = object(part?.functionResponse);
    if (locationChatReview && output.sessionId && response?.name === "propose_location_action") {
      locationChatProposal = parseMainLocationProposal(response.response) ?? locationChatProposal;
      continue;
    }
    if (response?.name !== A2UI_TOOL) continue;
    const messages = object(response.response)?.validated_a2ui_json;
    if (!Array.isArray(messages) || messages.length > 24) continue;
    for (const message of messages) surfaces = applyA2uiMessage(surfaces, message);
  }
  if (!text && surfaces === output.surfaces && locationChatProposal === output.locationChatProposal) return output;
  if (!text) return { ...output, surfaces, locationChatProposal };
  // ADK's settled text is the aggregate from the model call. Replace its
  // provisional chunks instead of appending the same answer twice.
  const eventId = typeof event.id === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(event.id)
    ? event.id : undefined;
  return { ...output, surfaces, locationChatProposal, settledText: output.settledText + text, partialText: "", serverMessageId: eventId };
}

export function consumeNativeAdkFrames(
  output: NativeAdkTurnOutput, chunk: string, remainder = "", locationChatReview = false,
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
      next = applyNativeAdkEvent(next, value, locationChatReview);
      continue;
    }
    const payload = object(value);
    if (!payload) continue;
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
  locationChatReview = false,
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
      const next = consumeNativeAdkFrames(output, decoder.decode(value, { stream: true }), remainder, locationChatReview);
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

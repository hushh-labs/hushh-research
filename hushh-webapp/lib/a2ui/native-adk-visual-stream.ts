import { parseSSEBlocks } from "../streaming/sse-parser";
import { applyA2uiMessage, type A2uiSurfaces } from "./surface-store";

const ONE_ROOT = "one";
const A2UI_TOOL = "send_a2ui_json_to_client";
type NativeErrorCode = "POD_CHAT_BUSY" | "AGENT_ERROR";

export type NativeAdkTurnOutput = {
  surfaces: A2uiSurfaces;
  settledText: string;
  partialText: string;
  status: "streaming" | "complete" | "awaiting_review" | "error";
  errorCode?: NativeErrorCode;
};

export function createNativeAdkTurnOutput(): NativeAdkTurnOutput {
  return { surfaces: new Map(), settledText: "", partialText: "", status: "streaming" };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
  // ADK's settled text is the aggregate from the model call. Replace its
  // provisional chunks instead of appending the same answer twice.
  return { ...output, surfaces, settledText: output.settledText + (text || output.partialText), partialText: "" };
}

export function consumeNativeAdkFrames(
  output: NativeAdkTurnOutput, chunk: string, remainder = "",
): { output: NativeAdkTurnOutput; remainder: string } {
  const parsed = parseSSEBlocks(chunk, remainder, "message");
  let next = output;
  for (const { event, data } of parsed.events) {
    if (next.status !== "streaming") break;
    if (event !== "message" && event !== "done" && event !== "review" && event !== "error") continue;
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
    if (event === "done" && Object.keys(payload).length === 0) {
      next = { ...next, status: "complete", settledText: next.settledText + next.partialText, partialText: "" };
    } else if (event === "review" && Object.keys(payload).length === 0) {
      next = { ...next, status: "awaiting_review", partialText: "" };
    } else if (event === "error") {
      const errorCode = payload.code === "POD_CHAT_BUSY" ? "POD_CHAT_BUSY" : "AGENT_ERROR";
      next = { ...next, status: "error", errorCode };
    }
  }
  return { output: next, remainder: parsed.remainder };
}

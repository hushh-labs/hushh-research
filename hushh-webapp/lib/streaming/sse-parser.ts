import type { ParsedSSEFrame } from "./kai-stream-types";

export interface ParseSSEBlocksResult {
  events: ParsedSSEFrame[];
  remainder: string;
}

/**
 * Maximum byte length of a single SSE frame data payload (CWE-400).
 * Prevents a malicious or runaway backend from crashing the browser tab
 * by sending an unbounded JSON frame into the parser.
 */
export const MAX_FRAME_BYTES = 1 * 1024 * 1024; // 1 MB

export function parseSSEBlocks(chunk: string, remainder = ""): ParseSSEBlocksResult {
  const normalized = (remainder + chunk).replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const nextRemainder = blocks.pop() ?? "";

  const events: ParsedSSEFrame[] = [];
  for (const rawBlock of blocks) {
    if (!rawBlock.trim()) continue;

    let eventName: string | undefined;
    let eventId: string | undefined;
    const dataLines: string[] = [];

    const lines = rawBlock.split("\n");
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("id:")) {
        eventId = line.slice(3).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (!eventName || dataLines.length === 0) {
      continue;
    }

    const rawData = dataLines.join("\n");
    const byteLength = new TextEncoder().encode(rawData).length;
    if (byteLength > MAX_FRAME_BYTES) {
      throw new Error(
        `SSE frame data exceeds maximum allowed size of ${MAX_FRAME_BYTES} bytes`
      );
    }

    events.push({
      event: eventName,
      id: eventId,
      data: rawData,
    });
  }

  return { events, remainder: nextRemainder };
}

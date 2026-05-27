import type { ParsedSSEFrame } from "./kai-stream-types";

export interface ParseSSEBlocksResult {
  events: ParsedSSEFrame[];
  remainder: string;
}

/**
 * Parses Server-Sent Event blocks from a streamed chunk, carrying the
 * unterminated tail forward via `remainder` so fragmented frames are
 * correctly reassembled across reads.
 */
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

    events.push({
      event: eventName,
      id: eventId,
      data: dataLines.join("\n"),
    });
  }

  return { events, remainder: nextRemainder };
}
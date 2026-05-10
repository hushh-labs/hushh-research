// hushh-webapp/lib/streaming/sse-parser.ts
import type { ParsedSSEFrame } from "./kai-stream-types";

export interface ParseSSEBlocksResult {
  events: ParsedSSEFrame[];
  remainder: string;
}

export interface SSEBlockResult {
  parsedEvents: Record<string, unknown>[];
  leftoverBuffer: string;
}

// 1MB hard limit on unparsed chunks to prevent OOM tab crashes
const MAX_BUFFER_SIZE = 1024 * 1024;

/**
 * Robustly parses standard SSE chunks into discrete frames.
 * Handles fragmentation by keeping a remainder buffer.
 */
export function parseSSEBlocks(chunk: string, existingBuffer: string = ''): ParseSSEBlocksResult {
  if (existingBuffer.length + chunk.length > MAX_BUFFER_SIZE) {
    console.error('SSE Buffer overflow threshold reached. Forcefully dropping fragment to prevent OOM crash.');
    return { events: [], remainder: '' };
  }

  const combined = existingBuffer + chunk;
  const blocks = combined.split('\n\n');

  const isComplete = combined.endsWith('\n\n');
  const remainder = isComplete ? '' : (blocks.pop() ?? '');

  const events: ParsedSSEFrame[] = [];

  for (const block of blocks) {
    const trimmedBlock = block.trim();
    if (!trimmedBlock) continue;

    const lines = trimmedBlock.split('\n');
    let eventName: string | undefined = undefined;
    let dataStr = '';
    let idStr: string | undefined = undefined;

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.replace(/^event:\s*/, '');
      } else if (line.startsWith('data:')) {
        const dataPart = line.replace(/^data:\s*/, '');
        dataStr = dataStr ? dataStr + '\n' + dataPart : dataPart;
      } else if (line.startsWith('id:')) {
        idStr = line.replace(/^id:\s*/, '');
      }
    }

    if (eventName !== undefined || dataStr) {
      const frame: Record<string, string> = { data: dataStr };
      if (eventName !== undefined) frame.event = eventName;
      if (idStr !== undefined) frame.id = idStr;
      
      events.push(frame as unknown as ParsedSSEFrame);
    }
  }

  return { events, remainder };
}

/**
 * Convenience function for JSON-only streams without event types.
 * Robustly parses SSE chunks. If a network chunk ends mid-message, 
 * it saves the fragment to be prepended to the next chunk.
 */
export function parseSSEChunk(chunk: string, existingBuffer: string = ''): SSEBlockResult {
  const result = parseSSEBlocks(chunk, existingBuffer);
  const parsedEvents: Record<string, unknown>[] = [];

  for (const frame of result.events) {
    if (frame.data === '[DONE]') continue;
    if (frame.data.trim().length === 0) continue;

    try {
      const parsed = JSON.parse(frame.data) as Record<string, unknown>;
      parsedEvents.push(parsed);
    } catch (_e) {
      console.warn('SSE JSON Parse skip (fragment):', frame.data);
    }
  }

  return { parsedEvents, leftoverBuffer: result.remainder };
}
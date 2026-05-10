// hushh-webapp/lib/streaming/sse-parser.ts

export interface SSEBlockResult {
  parsedEvents: Record<string, unknown>[];
  leftoverBuffer: string;
}

// 1MB hard limit on unparsed chunks to prevent OOM tab crashes
const MAX_BUFFER_SIZE = 1024 * 1024;

/**
 * Robustly parses SSE chunks. If a network chunk ends mid-message, 
 * it saves the fragment to be prepended to the next chunk.
 */
export function parseSSEChunk(chunk: string, existingBuffer: string = ''): SSEBlockResult {
  // Circuit Breaker: Prevent infinite memory growth on malformed streams
  if (existingBuffer.length + chunk.length > MAX_BUFFER_SIZE) {
    console.error('SSE Buffer overflow threshold reached. Forcefully dropping fragment to prevent OOM crash.');
    return { parsedEvents: [], leftoverBuffer: '' };
  }

  const combined = existingBuffer + chunk;
  
  // SSE events are separated by double newlines
  const blocks = combined.split('\n\n');

  // If the chunk didn't end with double newlines, the last block is incomplete
  const isComplete = combined.endsWith('\n\n');
  const leftoverBuffer = isComplete ? '' : (blocks.pop() ?? '');

  const parsedEvents: Record<string, unknown>[] = [];

  for (const block of blocks) {
    const trimmedBlock = block.trim();
    if (trimmedBlock.startsWith('data: ')) {
      const jsonStr = trimmedBlock.replace(/^data:\s*/, '');
      
      if (jsonStr === '[DONE]') continue;
      if (jsonStr.trim().length === 0) continue; // Skip empty payloads to save CPU cycles

      try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        parsedEvents.push(parsed);
      } catch (_e) { // Changed 'e' to '_e' to pass strict linting
        console.warn('SSE JSON Parse skip (fragment):', jsonStr);
      }
    }
  }

  return { parsedEvents, leftoverBuffer };
}

/**
 * Legacy wrapper to support existing imports.
 * @deprecated Use parseSSEChunk with buffer state for robust streaming.
 */
export function parseSSEBlocks(chunk: string, existingBuffer: string = ''): { events: any[]; remainder: string } {
  const result = parseSSEChunk(chunk, existingBuffer);
  return {
    events: result.parsedEvents,
    remainder: result.leftoverBuffer
  };
}
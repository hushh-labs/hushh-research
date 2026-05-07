// hushh-webapp/lib/streaming/sse-parser.ts

export interface SSEBlockResult {
  parsedEvents: Record<string, unknown>[];
  leftoverBuffer: string;
}

/**
 * Robustly parses SSE chunks. If a network chunk ends mid-message,
 * it saves the fragment to be prepended to the next chunk.
 */
export function parseSSEBlocks(chunk: string, existingBuffer = ''): SSEBlockResult {
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
      const jsonStr = trimmedBlock.slice('data: '.length);

      if (jsonStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        parsedEvents.push(parsed);
      } catch {
        console.warn('SSE JSON Parse skip (fragment):', jsonStr);
      }
    }
  }

  return { parsedEvents, leftoverBuffer };
}

// Alias for backwards compatibility
export const parseSSEChunk = parseSSEBlocks;
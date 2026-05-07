// hushh-webapp/lib/streaming/sse-parser.ts

export interface SSEBlockResult {
  // Changed any[] to Record<string, unknown>[] for type safety
  parsedEvents: Record<string, unknown>[];
  leftoverBuffer: string;
}

/**
 * Robustly parses Server-Sent Events (SSE) chunks. 
 * If a network chunk splits a message in half, it saves the fragment 
 * in a buffer to be combined with the next incoming chunk.
 */
export function parseSSEChunk(chunk: string, existingBuffer: string = ''): SSEBlockResult {
  const combined = existingBuffer + chunk;
  
  // SSE events are strictly separated by double newlines
  const blocks = combined.split('\n\n');

  // If the chunk didn't end with double newlines, the very last block is incomplete.
  const isComplete = combined.endsWith('\n\n');
  const leftoverBuffer = isComplete ? '' : (blocks.pop() || '');

  const parsedEvents = blocks
    .map(block => block.trim())
    .filter(block => block.startsWith('data: '))
    .map(block => {
      // Fixed the regex to be more standard and clear
      const jsonStr = block.replace('data: ', '');
      
      if (jsonStr === '[DONE]') return null;
      
      try {
        return JSON.parse(jsonStr) as Record<string, unknown>;
      } catch (e) {
        console.warn('SSE JSON Parse skip (fragmented frame):', jsonStr);
        return null;
      }
    })
    .filter((event): event is Record<string, unknown> => event !== null);

  return { parsedEvents, leftoverBuffer };
}
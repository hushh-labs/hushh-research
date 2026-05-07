// hushh-webapp/lib/streaming/sse-parser.ts

export interface SSEBlockResult {
  parsedEvents: any[];
  leftoverBuffer: string;
}

/**
 * Robustly parses SSE chunks. If a network chunk ends mid-message, 
 * it saves the fragment to be prepended to the next chunk.
 */
export function parseSSEChunk(chunk: string, existingBuffer: string = ''): SSEBlockResult {
  const combined = existingBuffer + chunk;
  
  // SSE events are strictly separated by double newlines
  const blocks = combined.split('\n\n');

  // If the chunk didn't end with double newlines, the last block is incomplete
  const isComplete = combined.endsWith('\n\n');
  const leftoverBuffer = isComplete ? '' : (blocks.pop() || '');

  const parsedEvents = blocks
    .map(block => block.trim())
    .filter(block => block.startsWith('data: '))
    .map(block => {
      const jsonStr = block.replace('data: ', '');
      if (jsonStr === '[DONE]') return null;
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        console.warn('SSE JSON Parse skip (fragment):', jsonStr);
        return null;
      }
    })
    .filter(Boolean);

  return { parsedEvents, leftoverBuffer };
}
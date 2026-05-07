

export interface SSEBlockResult {
  parsedEvents: any[];
  leftoverBuffer: string;
}



export function parseSSEChunk(chunk: string, existingBuffer: string = ''): SSEBlockResult {
  const combined = existingBuffer + chunk;
  
 
  const blocks = combined.split('\n\n');

  const isComplete = combined.endsWith('\n\n');
  const leftoverBuffer = isComplete ? '' : (blocks.pop() || '');

  const parsedEvents = blocks
    .map(block => block.trim())
    .filter(block => block.startsWith('data: '))
    .map(block => {
      const jsonStr = block.replace(/^data:\s*/, '');
      
      // Standard SSE end-of-stream marker
      if (jsonStr === '[DONE]') return null;
      
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        console.warn('SSE JSON Parse skip (fragmented frame):', jsonStr);
        return null;
      }
    })
    .filter(Boolean); // Removes the nulls

  return { parsedEvents, leftoverBuffer };
}
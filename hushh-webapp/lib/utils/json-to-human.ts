export interface ParserContext {
  buffer: string;
  depth: number;
  inString: boolean;
  lastOutput: string;
}

export function createParserContext(): ParserContext {
  return { buffer: '', depth: 0, inString: false, lastOutput: '' };
}

export function formatJsonChunk(chunk: string, context: ParserContext): { text: string } {
  context.buffer += chunk;
  const safeText = escapeHtml(chunk);
  context.lastOutput = safeText;
  return { text: safeText };
}

export function tryFormatComplete(data: unknown): string {
  try {
    if (typeof data === 'string') {
      try { return jsonToHuman(JSON.parse(data)); } catch { return escapeHtml(data); }
    }
    return jsonToHuman(data);
  } catch {
    return escapeHtml(String(data));
  }
}

export function escapeHtml(unsafe: string): string {
  if (typeof unsafe !== 'string') return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function jsonToHuman(payload: unknown, depth: number = 0): string {
  if (payload === null || payload === undefined) return 'None';
  if (typeof payload === 'string') return escapeHtml(payload);
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload);
  if (Array.isArray(payload)) {
    if (payload.length === 0) return 'Empty list';
    return payload.map(item => jsonToHuman(item, depth + 1)).join(', ');
  }
  if (typeof payload === 'object') {
    const entries = Object.entries(payload as Record<string, unknown>);
    if (entries.length === 0) return 'Empty data';
    return entries.map(([key, value]) =>
      `${escapeHtml(key)}: ${jsonToHuman(value, depth + 1)}`
    ).join(' | ');
  }
  return 'Unknown format';
}

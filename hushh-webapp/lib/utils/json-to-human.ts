// hushh-webapp/lib/utils/json-to-human.ts

/**
 * Safely escapes HTML characters to prevent DOM XSS injection
 * when rendering untrusted marketplace payloads in the Consent UI.
 */
export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Recursively converts a JSON object or string into a safe, human-readable format.
 * Used primarily by the Consent Center to display requested scopes and payloads.
 */
export function jsonToHuman(payload: unknown, depth: number = 0): string {
  if (payload === null || payload === undefined) return 'None';
  
  if (typeof payload === 'string') {
    // CRITICAL XSS FIX: Escape all string values coming from untrusted third-party apps
    return escapeHtml(payload);
  }
  
  if (typeof payload === 'number' || typeof payload === 'boolean') {
    return String(payload);
  }
  
  if (Array.isArray(payload)) {
    if (payload.length === 0) return 'Empty list';
    return payload.map(item => jsonToHuman(item, depth + 1)).join(', ');
  }
  
  if (typeof payload === 'object') {
    const entries = Object.entries(payload as Record<string, unknown>);
    if (entries.length === 0) return 'Empty data';
    
    return entries.map(([key, value]) => {
      // Escape keys as well, as malicious apps might use object keys as injection vectors
      const safeKey = escapeHtml(key);
      const safeValue = jsonToHuman(value, depth + 1);
      return `${safeKey}: ${safeValue}`;
    }).join(' | ');
  }
  
  return 'Unknown format';
}
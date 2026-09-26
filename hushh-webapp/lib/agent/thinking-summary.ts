/**
 * Joins streamed provider thought-summary chunks for display.
 *
 * Gemini writes each summary as markdown that opens with a bold heading
 * ("**Clarifying My Role**"). Chunks from successive model steps arrive back to
 * back, so a new heading can land on the same line as the previous paragraph and
 * lose its heading shape. A heading chunk therefore always starts a new paragraph.
 * The result stays bounded; summaries are transient and never stored.
 */
export const THINKING_SUMMARY_MAX_CHARS = 12000;

const HEADING_START = /^\s*\*\*[^*\n]/;

export function appendThinkingSummary(previous: string | undefined, chunk: string): string {
  const current = previous ?? "";
  if (!chunk) return current.slice(0, THINKING_SUMMARY_MAX_CHARS);
  const needsBreak =
    current.length > 0 && HEADING_START.test(chunk) && !/\n\s*\n\s*$/.test(current);
  const separator = needsBreak ? (current.endsWith("\n") ? "\n" : "\n\n") : "";
  return `${current}${separator}${chunk}`.slice(0, THINKING_SUMMARY_MAX_CHARS);
}

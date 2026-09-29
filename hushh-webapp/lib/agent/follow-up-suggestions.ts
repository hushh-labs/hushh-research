/**
 * Smart follow-ups: 2-3 next questions One wrote in the same model response as
 * its answer, carried by the `suggest_follow_ups` tool result.
 *
 * The server tool validates and ends the turn; this parser only admits what the
 * server marked `shown`, with the same bounds, so a malformed or partial result
 * renders nothing rather than a garbled chip. Suggestions are turn content:
 * they live in memory on the latest answer and are never logged or persisted.
 */
export const FOLLOW_UP_TOOL_NAME = "suggest_follow_ups" as const;

const MIN_SUGGESTIONS = 2;
const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_CHARS = 80;
const CONTROL = /[\x00-\x1f\x7f]/;

function parseRecord(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

/** The chips to show, or null when the result does not carry 2-3 valid ones. */
export function parseFollowUpSuggestions(content: unknown): string[] | null {
  const result = parseRecord(content);
  const raw = result?.suggestions;
  if (result?.status !== "shown" || !Array.isArray(raw)) return null;
  const suggestions = raw.filter((item): item is string =>
    typeof item === "string" && item.trim() === item && item.length > 0 &&
    item.length <= MAX_SUGGESTION_CHARS && !CONTROL.test(item));
  if (suggestions.length !== raw.length) return null;
  if (suggestions.length < MIN_SUGGESTIONS || suggestions.length > MAX_SUGGESTIONS) return null;
  if (new Set(suggestions.map((item) => item.toLowerCase())).size !== suggestions.length) return null;
  return suggestions;
}

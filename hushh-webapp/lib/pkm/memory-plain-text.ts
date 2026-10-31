/**
 * Markdown formatting removed from text that becomes a Memory detail.
 *
 * People paste notes written for chat or documents: headings, bullet markers
 * and bold labels. That formatting describes the note's layout, not the fact,
 * so it must not reach an encrypted value or a review title. This only removes
 * markup; it never rewrites or re-derives the words the agent returned.
 *
 * Deliberately conservative: a `#` or `*` that is not markup (`C#`, `#1`,
 * `5 * 3`, `snake_case`) is left alone. Line structure is kept, so a value that
 * was a bullet list stays a clean list of lines.
 */

const LINE_MARKER = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+•][ \t]+|\d{1,3}[.)][ \t]+)/;
const RULE_LINE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;

function stripInlineEmphasis(line: string): string {
  return line
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "$1")
    // `__x__` is also an identifier shape (`__init__`); only a label-like span
    // (one with a space or colon, such as `__Home city:__`) is emphasis.
    .replace(/__(?=\S)([^_\n]*?[\s:][^_\n]*?\S|[^_\n]*?:)__/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2");
}

export function toPlainMemoryText(value: string): string {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !RULE_LINE.test(line))
    .map((line) => stripInlineEmphasis(line.replace(LINE_MARKER, "")).trimEnd());
  const plain = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Never turn a returned value into nothing: text that is only markup stays as written.
  return plain || value.trim();
}

/** Apply `toPlainMemoryText` to every string inside a JSON-shaped value; keys are untouched. */
export function toPlainMemoryValue<T>(value: T): T {
  if (typeof value === "string") return toPlainMemoryText(value) as T;
  if (Array.isArray(value)) return value.map((item) => toPlainMemoryValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        toPlainMemoryValue(nested),
      ]),
    ) as T;
  }
  return value;
}

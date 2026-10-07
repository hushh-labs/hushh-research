/** Presentation only: never modify the arguments used for approval. */
export function escapeReviewText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Bound traversal before JSON.stringify, including the collapsed raw view.
 * Refuse an unreviewable payload instead of approving a truncated projection.
 */
export function serializeReviewArguments(value: unknown, pretty = false): string | null {
  let nodes = 0;
  let characters = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 8192 || depth > 64) return false;
    if (typeof item === "string") {
      characters += item.length;
      return characters <= 32768;
    }
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > 8192) return false;
      return item.every(child => visit(child, depth + 1));
    }
    for (const [key, child] of Object.entries(item)) {
      characters += key.length;
      if (characters > 32768 || !visit(child, depth + 1)) return false;
    }
    return true;
  };
  try {
    if (!visit(value, 0)) return null;
    const compact = JSON.stringify(value);
    if (new TextEncoder().encode(compact).length > 32768) return null;
    return pretty ? JSON.stringify(value, null, 2) : compact;
  } catch { return null; }
}

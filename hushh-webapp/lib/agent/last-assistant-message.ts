/** The last assistant message with content in a messages snapshot: this turn's answer. */
export function lastAssistantMessageId(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index];
    const message =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : null;
    if (!message || message.role !== "assistant") continue;
    const content = message.content;
    const hasContent =
      (typeof content === "string" && content.trim().length > 0) ||
      (Array.isArray(content) && content.length > 0);
    const id = typeof message.id === "string" ? message.id.trim() : "";
    if (hasContent && id) return id;
  }
  return null;
}

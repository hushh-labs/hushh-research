/** Fixed public copy for server-authored terminal chat codes. */
export const MODEL_CAPACITY_MESSAGE = "One is temporarily at capacity. Please try again in a moment.";

const MESSAGES: Record<string, string> = {
  RESOURCE_EXHAUSTED: MODEL_CAPACITY_MESSAGE,
  MODEL_UNAVAILABLE: "One's model service was briefly unavailable. Please try again.",
  SERVER_RESTARTING: "One was interrupted because the service restarted. Please send that again.",
  TEXT_AUTHORITY_ENDED: "Chat access changed. Please check your access before trying again.",
  TEXT_CONTENT_FILTERED: "This response was filtered. Try rephrasing your message.",
};

export function managedChatRunErrorMessage(code?: string): string | undefined {
  return code && Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : undefined;
}

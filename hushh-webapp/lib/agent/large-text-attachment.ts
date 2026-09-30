/**
 * A large text paste in One's composer. While it is being composed it is
 * UI-only state in browser memory. On send it becomes an `AgentTextAttachment`:
 * a chip in the transcript and a separate `text/plain` document part on the
 * wire, never text folded into the person's message.
 */
export const LARGE_PASTE_ATTACHMENT_CHARS = 1_200;
export const LARGE_PASTE_ATTACHMENT_LINES = 12;

export type PendingTextAttachment = {
  text: string;
  byteSize: number;
  isExpanded: boolean;
};

export function shouldCaptureLargePaste(text: string): boolean {
  return (
    text.length >= LARGE_PASTE_ATTACHMENT_CHARS ||
    text.split(/\r?\n/).length >= LARGE_PASTE_ATTACHMENT_LINES
  );
}

export function createPendingTextAttachment(
  text: string,
  isExpanded = false,
): PendingTextAttachment {
  return {
    text,
    byteSize: new TextEncoder().encode(text).byteLength,
    isExpanded,
  };
}

export function getTextAttachmentTitle(text: string): string {
  const source = text.trimStart();
  const preview = source.slice(0, 72).replace(/\s+/g, " ").trim();
  if (!preview) return "Pasted text";
  return source.length > 72 ? `${preview}…` : preview;
}

export function combineAttachmentAndComposerText({
  attachmentText,
  composerText,
}: {
  attachmentText: string | null;
  composerText: string;
}): string {
  if (!attachmentText) return composerText;
  return composerText.trim()
    ? `${composerText.trim()}\n\n${attachmentText}`
    : attachmentText;
}

export function mergePastedText({
  currentText,
  pastedText,
  selectionStart,
  selectionEnd,
}: {
  currentText: string;
  pastedText: string;
  selectionStart: number;
  selectionEnd: number;
}): string {
  return `${currentText.slice(0, selectionStart)}${pastedText}${currentText.slice(selectionEnd)}`;
}

/** The name every pasted-text attachment carries, in the chip and to One. */
export const PASTED_TEXT_ATTACHMENT_NAME = "Pasted text";
export const TEXT_ATTACHMENT_MIME_TYPE = "text/plain";

/**
 * A pasted text sent with a turn as its own document part. The transcript
 * shows it as a chip; the model receives it as a `text/plain` document; it is
 * never concatenated into the message text the person typed.
 */
export type AgentTextAttachment = {
  name: string;
  mimeType: typeof TEXT_ATTACHMENT_MIME_TYPE;
  text: string;
  byteSize: number;
  lineCount: number;
};

export function countTextLines(text: string): number {
  return text ? text.split(/\r\n|\r|\n/).length : 0;
}

export function createAgentTextAttachment(
  text: string,
  name: string = PASTED_TEXT_ATTACHMENT_NAME,
): AgentTextAttachment {
  return {
    name,
    mimeType: TEXT_ATTACHMENT_MIME_TYPE,
    text,
    byteSize: new TextEncoder().encode(text).byteLength,
    lineCount: countTextLines(text),
  };
}

/**
 * "Edit and send again": a sent message never changes, so an edit produces a
 * NEW attachment list for a new turn. The edited entry keeps its name; every
 * other attachment is carried over as it was sent. Returns null for an index
 * that is not there or an edit that left nothing to send.
 */
export function replaceTextAttachmentForResend(
  attachments: readonly AgentTextAttachment[],
  index: number,
  editedText: string,
): AgentTextAttachment[] | null {
  const original = attachments[index];
  if (!original || !editedText.trim()) return null;
  return attachments.map((attachment, position) =>
    position === index ? createAgentTextAttachment(editedText, original.name) : attachment,
  );
}

export function formatTextAttachmentSize({
  byteSize,
  lineCount,
}: Pick<AgentTextAttachment, "byteSize" | "lineCount">): string {
  return `${lineCount} ${lineCount === 1 ? "line" : "lines"} · ${(byteSize / 1024).toFixed(1)} KB`;
}

/**
 * Everything the person supplied in one turn, for the on-device lanes that
 * read the turn whole: private-memory lookup and memory capture. It is the
 * same text those lanes received when a paste was folded into the message, so
 * capture keeps seeing the pasted content and keeps its existing chunking.
 */
export function composeTurnSourceText(
  text: string,
  attachments: readonly AgentTextAttachment[],
): string {
  return attachments
    .reduce(
      (combined, attachment) =>
        combineAttachmentAndComposerText({
          attachmentText: attachment.text,
          composerText: combined,
        }),
      text,
    )
    .trim();
}

/**
 * Validate attachments read back from history. Only `text/plain` entries with
 * a string body are kept, and sizes are recomputed from the text rather than
 * trusted, so the chip always describes what it will preview.
 */
export function parseStoredTextAttachments(value: unknown): AgentTextAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (record.mimeType !== TEXT_ATTACHMENT_MIME_TYPE || typeof record.text !== "string") {
      return [];
    }
    const name =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim().slice(0, 120)
        : PASTED_TEXT_ATTACHMENT_NAME;
    return [createAgentTextAttachment(record.text, name)];
  });
}

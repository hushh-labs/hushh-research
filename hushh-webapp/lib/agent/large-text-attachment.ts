/**
 * UI-only state for a large text paste in One's composer. The text remains in
 * browser memory; this is deliberately not an upload or a file transport.
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

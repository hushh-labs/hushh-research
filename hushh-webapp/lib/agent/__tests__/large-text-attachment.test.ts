import { describe, expect, it } from "vitest";

import {
  LARGE_PASTE_ATTACHMENT_CHARS,
  LARGE_PASTE_ATTACHMENT_LINES,
  combineAttachmentAndComposerText,
  createPendingTextAttachment,
  getTextAttachmentTitle,
  mergePastedText,
  shouldCaptureLargePaste,
} from "@/lib/agent/large-text-attachment";

describe("large text attachment composer state", () => {
  it("captures a large character paste without making it an uploaded file", () => {
    const text = "a".repeat(LARGE_PASTE_ATTACHMENT_CHARS);

    expect(shouldCaptureLargePaste(text)).toBe(true);
    expect(createPendingTextAttachment(text)).toEqual({
      text,
      byteSize: LARGE_PASTE_ATTACHMENT_CHARS,
      isExpanded: false,
    });
  });

  it("captures a structured multiline paste even when it is short", () => {
    const text = Array.from(
      { length: LARGE_PASTE_ATTACHMENT_LINES },
      (_, index) => `line ${index + 1}`,
    ).join("\n");

    expect(shouldCaptureLargePaste(text)).toBe(true);
    expect(shouldCaptureLargePaste("A short note\nwith two lines")).toBe(false);
  });

  it("keeps a very large paste in the in-memory attachment state", () => {
    const text = "x".repeat(250_000);
    const attachment = createPendingTextAttachment(text);

    expect(shouldCaptureLargePaste(text)).toBe(true);
    expect(attachment.text).toBe(text);
    expect(attachment.byteSize).toBe(250_000);
  });

  it("preserves the exact composer text when a paste replaces a selection", () => {
    expect(mergePastedText({
      currentText: "Before selected after",
      pastedText: "captured text",
      selectionStart: 7,
      selectionEnd: 15,
    })).toBe("Before captured text after");
  });

  it("keeps a separate chat instruction alongside the attached text", () => {
    expect(combineAttachmentAndComposerText({
      attachmentText: "My long pasted context.",
      composerText: "Summarize this for me",
    })).toBe("Summarize this for me\n\nMy long pasted context.");
    expect(combineAttachmentAndComposerText({
      attachmentText: "My long pasted context.",
      composerText: "   ",
    })).toBe("My long pasted context.");
  });

  it("uses the opening words as the attachment title without scanning all content", () => {
    expect(getTextAttachmentTitle("\n\nA quick profile summary for an application\nMore details")).toBe(
      "A quick profile summary for an application More details",
    );
  });
});

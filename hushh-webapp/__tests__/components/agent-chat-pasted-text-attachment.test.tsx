import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import {
  AgentBubble,
  storedMessageToAgentMessage,
} from "@/components/agent/agent-chat-workspace";
import { AgentMessageAttachments } from "@/components/agent/agent-message-attachments";
import {
  AgentComposerTextAttachment,
  findTextOffsets,
} from "@/components/agent/agent-text-attachment-editor";
import {
  composeTurnSourceText,
  createAgentTextAttachment,
  createPendingTextAttachment,
  replaceTextAttachmentForResend,
  type AgentTextAttachment,
  type PendingTextAttachment,
} from "@/lib/agent/large-text-attachment";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import * as clipboard from "@/lib/utils/clipboard";

/**
 * Founder report: a long paste became a "Pasted text" chip in the composer,
 * then arrived in the transcript as one enormous user bubble listing every
 * line. The paste is an attachment end to end: a chip in the bubble, a chip on
 * reload, a separate part on the wire, and still whole for memory capture.
 */
const PASTE = Array.from({ length: 30 }, (_, index) => `ledger row ${index}`).join("\n");

type BubbleMessage = Parameters<typeof AgentBubble>[0]["message"];

function userMessage(text: string): BubbleMessage {
  return {
    id: "msg-1-user",
    role: "user",
    text,
    timestamp: "9:41 AM",
    attachments: [createAgentTextAttachment(PASTE)],
  };
}

describe("sent user bubble with a pasted attachment", () => {
  it("shows the typed text and a compact chip, never the pasted body", () => {
    render(<AgentBubble message={userMessage("Summarize this")} />);

    expect(screen.getByText("Summarize this")).toBeTruthy();
    const chip = screen.getByRole("button", { name: /Pasted text/ });
    expect(chip.textContent).toContain("30 lines");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/ledger row 7/)).toBeNull();
  });
});

/**
 * Founder ask (2026-09-27): read a long paste in a real viewer inside the
 * app, without interrupting the chat. Desktop is a non-modal panel beside the
 * transcript; a phone is the modal bottom sheet. Opening and closing must not
 * disturb the composer draft, and focus goes back to the chip.
 */
describe("text attachment viewer", () => {
  const originalWidth = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    vi.restoreAllMocks();
  });

  function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  }

  /** The chat around a sent chip: a composer holding an unsent draft. */
  function ChatHarness() {
    const [draft, setDraft] = useState("half-typed reply");
    return (
      <>
        <AgentBubble message={userMessage("Summarize this")} />
        <textarea aria-label="Message" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </>
    );
  }

  it("opens the whole text with its size, and Escape returns focus to the chip", async () => {
    render(<ChatHarness />);
    const chip = screen.getByRole("button", { name: /Pasted text/ });

    fireEvent.click(chip);
    const viewer = await screen.findByTestId("text-attachment-viewer");
    expect(viewer.dataset.presentation).toBe("panel");
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(within(viewer).getByTestId("text-attachment-viewer-summary").textContent).toBe(
      "30 lines · 0.4 KB",
    );
    // Every line, in order, with its line break preserved as a row.
    const body = within(viewer).getByTestId("text-attachment-viewer-body");
    expect(body.querySelectorAll("[data-line]")).toHaveLength(30);
    expect(body.textContent).toBe(PASTE.split("\n").join(""));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("text-attachment-viewer")).toBeNull());
    expect(document.activeElement).toBe(chip);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("half-typed reply");
  });

  it("keeps the chat usable beside the desktop panel", async () => {
    render(<ChatHarness />);
    fireEvent.click(screen.getByRole("button", { name: /Pasted text/ }));
    await screen.findByTestId("text-attachment-viewer");

    const composer = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.pointerDown(composer);
    fireEvent.focus(composer);
    composer.focus();
    fireEvent.change(composer, { target: { value: "half-typed reply, continued" } });

    // Negative control for the non-modal choice: a modal panel would have
    // closed (or made the composer inert) on this interaction.
    expect(screen.getByTestId("text-attachment-viewer")).toBeTruthy();
    expect(composer.closest("[aria-hidden='true'], [inert]")).toBeNull();
    expect(composer.value).toBe("half-typed reply, continued");
  });

  it("is the modal bottom sheet on a phone", async () => {
    setViewport(390);
    render(<ChatHarness />);
    const chip = screen.getByRole("button", { name: /Pasted text/ });
    fireEvent.click(chip);

    const viewer = await screen.findByTestId("text-attachment-viewer");
    expect(viewer.dataset.presentation).toBe("sheet");
    expect(screen.getByRole("button", { name: "Drag down to close" })).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("text-attachment-viewer")).toBeNull());
    expect(document.activeElement).toBe(chip);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("half-typed reply");
  });

  it("copies the whole text, not the visible part, and says so", async () => {
    const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(true);
    const success = vi.spyOn(morphyToast, "success").mockReturnValue("t" as never);
    render(<AgentBubble message={userMessage("")} />);
    fireEvent.click(screen.getByRole("button", { name: /Pasted text/ }));
    await screen.findByTestId("text-attachment-viewer");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(copy).toHaveBeenCalledWith(PASTE);
    expect(success).toHaveBeenCalledWith("Copied the whole text.");
  });

  it("renders a 50k-character paste in bounded chunks and finds past them", async () => {
    // 2,000 lines, ~60 KB. jsdom's IntersectionObserver never fires, so only
    // the chunks built at open exist; a find match forces its own chunk in.
    const large = Array.from({ length: 2_000 }, (_, index) =>
      index === 1_850 ? "needle in the late ledger" : `row ${index} ${"x".repeat(20)}`,
    ).join("\n");
    expect(large.length).toBeGreaterThan(50_000);
    render(<AgentMessageAttachments attachments={[createAgentTextAttachment(large)]} />);
    fireEvent.click(screen.getByRole("button", { name: /Pasted text/ }));
    const body = await screen.findByTestId("text-attachment-viewer-body");

    expect(body.querySelectorAll("[data-line]")).toHaveLength(400);
    expect(body.querySelectorAll('[data-text-chunk="pending"]')).toHaveLength(8);
    expect(screen.getByTestId("text-attachment-viewer-summary").textContent).toContain("2000 lines");

    fireEvent.change(screen.getByLabelText("Find in text"), { target: { value: "NEEDLE" } });
    await waitFor(() =>
      expect(screen.getByTestId("text-attachment-viewer-match-count").textContent).toBe("1 of 1"),
    );
    const active = body.querySelector("[data-active-match]");
    expect(active?.textContent).toBe("needle");
    expect(active?.closest("[data-line]")?.getAttribute("data-line")).toBe("1851");
  });

  it("steps through matches with Enter and Shift+Enter", async () => {
    render(<AgentBubble message={userMessage("")} />);
    fireEvent.click(screen.getByRole("button", { name: /Pasted text/ }));
    await screen.findByTestId("text-attachment-viewer");
    const find = screen.getByLabelText("Find in text");

    fireEvent.change(find, { target: { value: "row 1" } });
    // "row 1" and "row 10".."row 19": eleven matches.
    await waitFor(() =>
      expect(screen.getByTestId("text-attachment-viewer-match-count").textContent).toBe("1 of 11"),
    );
    fireEvent.keyDown(find, { key: "Enter" });
    expect(screen.getByTestId("text-attachment-viewer-match-count").textContent).toBe("2 of 11");
    fireEvent.keyDown(find, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(find, { key: "Enter", shiftKey: true });
    expect(screen.getByTestId("text-attachment-viewer-match-count").textContent).toBe("11 of 11");
  });
});

describe("reloaded history", () => {
  it("rehydrates the attachment as a chip beside the typed text", () => {
    const restored = storedMessageToAgentMessage({
      id: "event-1",
      conversation_id: "thread-1",
      role: "user",
      status: "complete",
      content: "Summarize this",
      metadata: { attachments: [createAgentTextAttachment(PASTE)] },
    });

    expect(restored?.text).toBe("Summarize this");
    expect(restored?.attachments).toEqual([createAgentTextAttachment(PASTE)]);

    render(<AgentBubble message={restored!} />);
    expect(screen.getByRole("button", { name: /Pasted text/ })).toBeTruthy();
    expect(screen.queryByText(/ledger row 7/)).toBeNull();
  });
});

describe("memory capture input", () => {
  it("still receives the whole turn: typed text first, then the pasted text", () => {
    const attachment = createAgentTextAttachment(PASTE);

    expect(composeTurnSourceText("Remember these", [attachment])).toBe(`Remember these\n\n${PASTE}`);
    expect(composeTurnSourceText("", [attachment])).toBe(PASTE);
    expect(composeTurnSourceText("Just typed", [])).toBe("Just typed");
  });

  it("is what the workspace hands the capture lane, while the wire gets the parts", () => {
    const source = readFileSync(
      join(process.cwd(), "components/agent/agent-chat-workspace.tsx"),
      "utf8",
    );
    const submit = source.slice(
      source.indexOf("const submitComposerText = async"),
      source.indexOf("const handleSubmit = async"),
    );

    // Send never folds the paste back into the message text.
    expect(submit).not.toContain("combineAttachmentAndComposerText");
    expect(submit).toContain("attachments: submittedAttachments");
    expect(source).toContain("const turnSourceText = composeTurnSourceText(text, attachments)");
    expect(source).toContain("sourceMessage: turnSourceText");
    expect(source).not.toMatch(/sourceMessage: text,/);
    expect(source).toMatch(/streamAgentChat\(\{\s+userId,\s+message: text,\s+attachments,/);
  });

  it("keeps text typed before a large paste as the message, not inside the chip", () => {
    const source = readFileSync(
      join(process.cwd(), "components/agent/agent-chat-workspace.tsx"),
      "utf8",
    );
    const paste = source.slice(
      source.indexOf("const handleComposerPaste = "),
      source.indexOf("const editLongPromptAttachment = "),
    );
    const collapsedBranch = paste.slice(paste.indexOf("return;\n    }"));

    expect(collapsedBranch).toContain("attachmentText: pasted");
    expect(collapsedBranch).not.toContain("setInput(");
    expect(collapsedBranch).not.toContain("currentText: input");
  });
});

/**
 * Founder ask (2026-09-29): the pasted-context viewer is an editor. Before
 * send, the composer chip opens an editable copy with Done and Cancel; after
 * send, the message stays as it was and "Edit and send again" makes a NEW
 * turn. The text stays in memory: nothing reaches web storage.
 */
describe("pasted text editor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  /** The composer around a pending paste, holding it the way the workspace does. */
  function ComposerHarness({ initial = PASTE }: { initial?: string }) {
    const [attachment, setAttachment] = useState<PendingTextAttachment | null>(
      createPendingTextAttachment(initial),
    );
    if (!attachment) return <p>No attachment</p>;
    return (
      <AgentComposerTextAttachment
        attachment={attachment}
        onChange={(text) =>
          setAttachment(text.trim() ? createPendingTextAttachment(text) : null)
        }
        onRemove={() => setAttachment(null)}
        onCollapse={() => undefined}
      />
    );
  }

  async function openComposerEditor() {
    fireEvent.click(screen.getByRole("button", { name: /Edit pasted text/ }));
    const editor = await screen.findByTestId("text-attachment-editor");
    const textarea = within(editor).getByLabelText("Pasted text, editable text") as HTMLTextAreaElement;
    return { editor, textarea };
  }

  function typeInto(textarea: HTMLTextAreaElement, value: string) {
    textarea.value = value;
    fireEvent.input(textarea);
  }

  it("edits the pending paste and Done updates the chip's text, size and line count", async () => {
    render(<ComposerHarness />);
    const chipSize = screen.getByTestId("agent-chat-text-attachment-size");
    expect(chipSize.textContent).toContain("30 lines");

    const { editor, textarea } = await openComposerEditor();
    expect(editor.dataset.presentation).toBe("panel");
    expect(textarea.value).toBe(PASTE);
    expect(within(editor).getByRole("button", { name: "Done" })).toBeTruthy();

    typeInto(textarea, "first line\nsecond line\nthird line");
    await waitFor(() =>
      expect(screen.getByTestId("text-attachment-editor-summary").textContent).toBe("3 lines · 0.0 KB"),
    );
    fireEvent.click(within(editor).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.queryByTestId("text-attachment-editor")).toBeNull());
    expect(screen.getByTestId("agent-chat-text-attachment-size").textContent).toBe(
      "Pasted text · 3 lines · 0.0 KB",
    );
    expect(screen.getByRole("button", { name: /Edit pasted text/ }).textContent).toContain(
      "first line second line third line",
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Edit pasted text/ }));
  });

  it("closes at once when nothing changed, and asks before discarding an edit", async () => {
    render(<ComposerHarness />);
    let { editor, textarea } = await openComposerEditor();
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("text-attachment-editor")).toBeNull());

    ({ editor, textarea } = await openComposerEditor());
    typeInto(textarea, "changed");
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    expect(within(editor).getByRole("alert").textContent).toBe("Discard changes?");
    expect(document.activeElement).toBe(within(editor).getByRole("button", { name: "Keep editing" }));

    // Escape answers "keep editing"; the edit is still there.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.getByTestId("text-attachment-editor")).toBeTruthy();
    expect(within(editor).queryByRole("alert")).toBeNull();
    expect(textarea.value).toBe("changed");

    // Escape with a change asks; Discard closes and leaves the chip untouched.
    fireEvent.keyDown(textarea, { key: "Escape" });
    fireEvent.click(within(editor).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByTestId("text-attachment-editor")).toBeNull());
    expect(screen.getByTestId("agent-chat-text-attachment-size").textContent).toContain("30 lines");
  });

  it("removes the attachment when the edit empties it", async () => {
    render(<ComposerHarness />);
    const { editor, textarea } = await openComposerEditor();
    typeInto(textarea, "   ");
    fireEvent.click(within(editor).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByText("No attachment")).toBeTruthy());
  });

  it("finds while editing without moving the caret, and replaces all", async () => {
    render(<ComposerHarness />);
    const { editor, textarea } = await openComposerEditor();
    textarea.setSelectionRange(5, 5);

    fireEvent.change(within(editor).getByLabelText("Find in text"), { target: { value: "ROW 2" } });
    // "row 2" and "row 20".."row 29": eleven matches, painted behind the text.
    await waitFor(() =>
      expect(screen.getByTestId("text-attachment-editor-match-count").textContent).toBe("1 of 11 matches"),
    );
    const highlights = screen.getByTestId("text-attachment-editor-highlights");
    expect(highlights.querySelectorAll("mark[data-find-match]")).toHaveLength(11);
    expect(highlights.textContent).toBe(`${PASTE}\n`);

    fireEvent.keyDown(within(editor).getByLabelText("Find in text"), { key: "Enter" });
    expect(screen.getByTestId("text-attachment-editor-match-count").textContent).toBe("2 of 11 matches");
    expect(highlights.querySelectorAll("mark[data-active-match]")).toHaveLength(1);
    expect(highlights.querySelectorAll("mark")[1]!.hasAttribute("data-active-match")).toBe(true);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([5, 5]);

    fireEvent.click(within(editor).getByRole("button", { name: "Replace and text options" }));
    fireEvent.change(within(editor).getByLabelText("Replace with"), { target: { value: "entry 2" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Replace all" }));
    await waitFor(() =>
      expect(screen.getByTestId("text-attachment-editor-match-count").textContent).toBe("No matches"),
    );
    expect(textarea.value).toContain("ledger entry 2\n");
    expect(textarea.value).toContain("ledger entry 29");
    expect(textarea.value).not.toContain("row 2");
  });

  it("offsets are case-insensitive and exact for text whose case changes its length", () => {
    expect(findTextOffsets("Row row ROW", "row").offsets).toEqual([0, 4, 8]);
    // "İ" lower-cases to two code units; the search keeps exact case.
    expect(findTextOffsets("İx row", "row").offsets).toEqual([3]);
    expect(findTextOffsets("aaaa", "a", 2)).toEqual({ offsets: [0, 1], truncated: true });
  });

  it("is the modal bottom sheet with no swipe-to-dismiss on a phone", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      render(<ComposerHarness />);
      const { editor, textarea } = await openComposerEditor();
      expect(editor.dataset.presentation).toBe("sheet");
      expect(editor.getAttribute("data-keyboard-anchor")).toBe("bottom");
      expect(screen.queryByRole("button", { name: "Drag down to close" })).toBeNull();
      // The keyboard stays down until the person taps into the text.
      expect(document.activeElement).not.toBe(textarea);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    }
  });

  it("sends an edited copy of a sent paste as a new turn and never changes the message", async () => {
    const sent = [createAgentTextAttachment(PASTE)] as const;
    const onResend = vi.fn(() => true);
    render(<AgentMessageAttachments attachments={sent} onResend={onResend} />);

    fireEvent.click(screen.getByRole("button", { name: /Pasted text/ }));
    const viewer = await screen.findByTestId("text-attachment-viewer");
    fireEvent.click(within(viewer).getByRole("button", { name: "Edit and send again" }));

    const editor = await screen.findByTestId("text-attachment-editor");
    const textarea = within(editor).getByLabelText("Pasted text, editable text") as HTMLTextAreaElement;
    expect(textarea.value).toBe(PASTE);
    typeInto(textarea, `${PASTE}\nledger row 30`);
    fireEvent.click(within(editor).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.queryByTestId("text-attachment-editor")).toBeNull());
    expect(onResend).toHaveBeenCalledWith(0, `${PASTE}\nledger row 30`);
    expect(sent[0].text).toBe(PASTE);
    expect(screen.getByRole("button", { name: /Pasted text/ }).textContent).toContain("30 lines");
  });

  it("offers no edit on a sent paste unless the chat can send", async () => {
    render(<AgentBubble message={userMessage("Summarize this")} />);
    fireEvent.click(screen.getByRole("button", { name: /Pasted text/ }));
    const viewer = await screen.findByTestId("text-attachment-viewer");
    expect(within(viewer).queryByRole("button", { name: "Edit and send again" })).toBeNull();
  });

  it("builds the resend list without touching the sent one", () => {
    const first = createAgentTextAttachment("first paste", "Pasted text");
    const second = createAgentTextAttachment("second paste", "Notes");
    const sent: readonly AgentTextAttachment[] = Object.freeze([first, second]);

    const next = replaceTextAttachmentForResend(sent, 1, "second paste, edited");
    expect(next).not.toBe(sent);
    expect(next?.[0]).toBe(first);
    expect(next?.[1]).toEqual(createAgentTextAttachment("second paste, edited", "Notes"));
    expect(sent[1]).toBe(second);
    expect(replaceTextAttachmentForResend(sent, 2, "x")).toBeNull();
    expect(replaceTextAttachmentForResend(sent, 0, "  \n")).toBeNull();
  });

  it("screens a resent paste with the same secret guard as a fresh one", () => {
    const source = readFileSync(
      join(process.cwd(), "components/agent/agent-chat-workspace.tsx"),
      "utf8",
    );
    const guard = source.slice(
      source.indexOf("const enqueueGuardedTurn = "),
      source.indexOf("const resendTextAttachment = "),
    );
    const resend = source.slice(
      source.indexOf("const resendTextAttachment = "),
      source.indexOf("const handleSubmit = async"),
    );
    // Typed text and every pasted attachment are kept in Secrets and replaced
    // by placeholders before the turn is queued.
    expect(guard).toContain("keepSecretsFromTurn([typedText, ...attachments.map((item) => item.text)])");
    expect(guard.indexOf("keepSecretsFromTurn(")).toBeLessThan(guard.indexOf("enqueuePrompt(submittedText"));
    expect(guard).toContain("createAgentTextAttachment(attachmentTexts[index]");
    expect(resend).toContain("enqueueGuardedTurn({");
    expect(resend).not.toContain("enqueuePrompt(");
    expect(resend).not.toMatch(/setMessages|updateMessage/);
  });

  it("keeps the paste out of web storage through a whole edit (with a live negative control)", async () => {
    const writes: string[] = [];
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      writes.push(`${key}=${value}`);
      setItem.call(this, key, value);
    });
    const leaked = () =>
      writes.some((entry) => entry.includes("ledger row")) ||
      [window.localStorage, window.sessionStorage].some((store) =>
        Object.keys(store).some((key) => (store.getItem(key) ?? "").includes("ledger row")),
      );

    render(<ComposerHarness />);
    const { editor, textarea } = await openComposerEditor();
    typeInto(textarea, `${PASTE}\nledger row 30`);
    fireEvent.change(within(editor).getByLabelText("Find in text"), { target: { value: "ledger" } });
    await waitFor(() =>
      expect(screen.getByTestId("text-attachment-editor-match-count").textContent).toBe("1 of 31 matches"),
    );
    fireEvent.click(within(editor).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByTestId("text-attachment-editor")).toBeNull());
    expect(leaked()).toBe(false);

    // Negative control: the detector does see a write when one happens.
    window.sessionStorage.setItem("probe", "ledger row 1");
    expect(leaked()).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import {
  AgentBubble,
  storedMessageToAgentMessage,
} from "@/components/agent/agent-chat-workspace";
import { AgentTextAttachmentViewButton } from "@/components/agent/agent-text-attachment-viewer";
import {
  composeTurnSourceText,
  createAgentTextAttachment,
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
    render(<AgentTextAttachmentViewButton name="Pasted text" text={large} />);
    fireEvent.click(screen.getByRole("button", { name: "View pasted text" }));
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
      source.indexOf("const openLongPromptAttachment = "),
    );
    const collapsedBranch = paste.slice(paste.indexOf("return;\n    }"));

    expect(collapsedBranch).toContain("attachmentText: pasted");
    expect(collapsedBranch).not.toContain("setInput(");
    expect(collapsedBranch).not.toContain("currentText: input");
  });
});

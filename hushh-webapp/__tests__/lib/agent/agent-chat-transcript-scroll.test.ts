import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findPendingAssistantTurn,
  transcriptRevealScrollTop,
  type TranscriptRevealGeometry,
} from "@/lib/agent/agent-chat-transcript-scroll";

/**
 * Founder report (2026-09-27): after sending a long prompt, the view stopped
 * at the end of the person's own message and "One is preparing your response"
 * sat below the fold. The composer overlays the transcript's reserved bottom
 * band; the old `scrollIntoView({ block: "end" })` aligned rows with the
 * bottom of the scrollport, which is inside that band.
 *
 * Geometry for these cases: an 800 px transcript (viewport y 0..800) whose
 * composer covers y 640..800, scrolled to 1000 of a 3000 px history.
 */
function geometry(element: { top: number; bottom: number }): TranscriptRevealGeometry {
  return {
    scrollTop: 1_000,
    scrollHeight: 3_000,
    clientHeight: 800,
    viewportTop: 0,
    visibleBottom: 640,
    elementTop: element.top,
    elementBottom: element.bottom,
  };
}

describe("transcriptRevealScrollTop", () => {
  it("lifts the pending turn above the composer, not merely into the scrollport", () => {
    // The pending row sits at y 900..960: below the fold entirely.
    const top = transcriptRevealScrollTop(geometry({ top: 900, bottom: 960 }));
    // Its bottom lands 16 px above the composer's top edge (640 - 16 = 624).
    expect(960 - (top - 1_000)).toBe(624);

    // Negative control: aligning with the scrollport's bottom (the old
    // block:"end") leaves the row under the composer band (y 640..800).
    const scrollportAligned = 1_000 + (960 - 800);
    const rowBottomThen = 960 - (scrollportAligned - 1_000);
    expect(rowBottomThen).toBeGreaterThan(640);
  });

  it("does not move a row that is already visible above the composer", () => {
    expect(transcriptRevealScrollTop(geometry({ top: 300, bottom: 360 }))).toBe(1_000);
  });

  it("shows the start of a row taller than the visible band", () => {
    const top = transcriptRevealScrollTop(geometry({ top: 700, bottom: 1_700 }));
    expect(700 - (top - 1_000)).toBe(16);
  });

  it("never scrolls past the end of the history", () => {
    expect(transcriptRevealScrollTop(geometry({ top: 5_000, bottom: 5_060 }))).toBe(2_200);
  });
});

describe("findPendingAssistantTurn", () => {
  it("targets the newest assistant row that is still streaming", () => {
    const transcript = document.createElement("div");
    transcript.innerHTML = `
      <div data-message-role="user" data-message-status="done" id="prompt"></div>
      <div data-message-role="assistant" data-message-status="done" id="older"></div>
      <div data-message-role="user" id="long-prompt"></div>
      <div data-message-role="assistant" data-message-status="streaming" id="pending"></div>`;
    expect(findPendingAssistantTurn(transcript)?.id).toBe("pending");

    transcript.querySelector("#pending")!.setAttribute("data-message-status", "done");
    expect(findPendingAssistantTurn(transcript)).toBeNull();
  });
});

describe("chat workspace send path", () => {
  const source = readFileSync(
    join(process.cwd(), "components/agent/agent-chat-workspace.tsx"),
    "utf8",
  );

  it("marks the submitted turn for Enter and for the Send button alike", () => {
    // The Send button calls submitComposerText directly; the marking used to
    // live only in the form's submit handler, so a click never scrolled.
    const submit = source.slice(
      source.indexOf("const submitComposerText = async"),
      source.indexOf("const handleSubmit = async"),
    );
    expect(submit).toContain("scrollToSubmittedTurnRef.current = true;");
    const handler = source.slice(
      source.indexOf("const handleSubmit = async"),
      source.indexOf("const handleComposerPaste = "),
    );
    expect(handler).not.toContain("scrollToSubmittedTurnRef");
  });

  it("scrolls to the pending turn, measured against the composer", () => {
    expect(source).toContain(
      "(submittedTurn ? findPendingAssistantTurn(transcript) : null) ?? messagesEnd",
    );
    expect(source).toContain(
      "measureTranscriptReveal(transcript, target, composerStackRef.current)",
    );
    expect(source).not.toMatch(/messagesEnd\.scrollIntoView\(/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findPendingAssistantTurn,
  transcriptFollowsLatest,
  transcriptRevealScrollTop,
  type TranscriptFollowState,
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

/**
 * Localhost run 2026-09-28 (screenshot 09, 393x852): the continuation reply was
 * revealed with its end at y 693, 16 px above the composer at 708. The reserved
 * padding is taller than the composer band, so that position is 86 px short of
 * the scroll bottom, and every later token of One's answer was treated as the
 * reader being away from the bottom: its last lines and actions grew under the
 * composer and bottom bar.
 */
describe("transcriptFollowsLatest", () => {
  const revealed: TranscriptFollowState = {
    userScrolled: false, submittedTurn: false, programmatic: false, scrollTop: 1_200,
    stuckToEnd: true, distanceFromBottom: 86, endBelowBand: 0,
  };
  /** The gate before the fix: the raw scroll bottom with a 48 px slack. */
  const oldGate = (state: TranscriptFollowState) => !state.userScrolled
    && (state.submittedTurn || state.programmatic || state.scrollTop <= 2 || state.distanceFromBottom <= 48);

  it("keeps following an answer that grows after it was revealed above the composer", () => {
    const grown = { ...revealed, distanceFromBottom: 86 + 60, endBelowBand: 60 };
    expect(transcriptFollowsLatest(grown)).toBe(true);
    // Not stuck (a fresh effect), the end a few lines below the composer: still the end.
    expect(transcriptFollowsLatest({ ...grown, stuckToEnd: false, endBelowBand: 30 })).toBe(true);
  });

  it("negative control: the old raw-bottom gate stops following after the first reveal", () => {
    expect(oldGate({ ...revealed, distanceFromBottom: 86 + 60, endBelowBand: 60 })).toBe(false);
  });

  it("never pulls a reader who scrolled away, or who is reading older history", () => {
    expect(transcriptFollowsLatest({ ...revealed, userScrolled: true, endBelowBand: 10 })).toBe(false);
    expect(transcriptFollowsLatest({ ...revealed, stuckToEnd: false, distanceFromBottom: 1_000, endBelowBand: 914 }))
      .toBe(false);
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
    // The follow gate is measured against the composer and sticky once followed.
    expect(source).toContain("measureTranscriptReveal(transcript, messagesEnd, composerStackRef.current)");
    expect(source).toContain("const shouldFollowTranscript = transcriptFollowsLatest({");
    expect(source).not.toContain("oneScrollTopRef.current <= 2 || distanceFromBottom <= 48");
  });
});

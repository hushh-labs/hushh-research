import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  VoiceTranscript,
  transcriptStatusLine,
} from "@/components/one-voice/voice-transcript";
import type { TranscriptItem } from "@/lib/one-voice/session-types";

afterEach(() => cleanup());

const items: TranscriptItem[] = [
  {
    id: "you:t1:0",
    role: "you",
    text: "Share my location with Priya",
    final: true,
    turnId: "t1",
  },
  {
    id: "one:t1:1",
    role: "one",
    text: "For how long",
    final: false,
    turnId: "t1",
  },
];

describe("VoiceTranscript", () => {
  it("is a polite live log with partial lines marked busy", () => {
    render(<VoiceTranscript items={items} />);
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAccessibleName("Conversation with One");
    const lines = screen.getAllByTestId("one-voice-transcript-line");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveAttribute("aria-busy", "false");
    expect(lines[0]).toHaveTextContent("You");
    expect(lines[0]).toHaveTextContent("Share my location with Priya");
    expect(lines[1]).toHaveAttribute("aria-busy", "true");
    expect(lines[1]).toHaveTextContent("One");
    expect(lines[1]).toHaveTextContent("For how long");
  });

  it("shows the compact cleared-conversation prompt when nothing has been said", () => {
    render(<VoiceTranscript items={[]} />);
    expect(screen.getByTestId("one-voice-transcript-empty")).toHaveTextContent(
      "Your messages will appear here.",
    );
  });

  it("lets a live decision or recovery card own the empty panel", () => {
    render(<VoiceTranscript items={[]} showEmptyState={false} />);
    expect(screen.queryByTestId("one-voice-transcript-empty")).toBeNull();
  });

  it("collapses to the latest line only", () => {
    render(<VoiceTranscript items={items} collapsed />);
    const lines = screen.getAllByTestId("one-voice-transcript-line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent("For how long");
    expect(lines[0]!.className).toContain("line-clamp-1");
  });

  it("derives the pill status line from the latest line", () => {
    expect(transcriptStatusLine(items)).toBe("One: For how long");
    expect(transcriptStatusLine(items.slice(0, 1))).toBe(
      "You said: Share my location with Priya",
    );
    expect(transcriptStatusLine([])).toBeNull();
    expect(
      transcriptStatusLine([
        { id: "x", role: "you", text: "   ", final: false, turnId: "t" },
      ]),
    ).toBeNull();
  });
});

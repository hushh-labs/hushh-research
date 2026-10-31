import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentMessageReactionBadge } from "../agent-message-reaction";
import { attachMessageReaction, parseMessageReaction } from "@/lib/agent/agent-message-reaction";

describe("message reactions", () => {
  it("admits only one server-shown emoji and a valid queued message reference", () => {
    expect(parseMessageReaction(JSON.stringify({ status: "shown", emoji: "🍕", clientMessageId: "queued-123" })))
      .toEqual({ reaction: { emoji: "🍕", actor: "agent" }, clientMessageId: "queued-123" });
    for (const value of ["invalid", {}, { emoji: "🤍" }, { status: "ignored", emoji: "🤍" },
      { status: "shown", emoji: "🤍🤍" }, { status: "shown", emoji: "constructor" },
      { status: "shown", emoji: "🤍", clientMessageId: "../wrong" }]) {
      expect(parseMessageReaction(value)).toBeNull();
    }
  });

  it("attaches once to the bound user, never to a newer turn or assistant", () => {
    const messages = [{ id: "original", role: "user" }, { id: "msg-queued-123", role: "user" },
      { id: "answer", role: "assistant" }, { id: "newer", role: "user" }];
    const reaction = { emoji: "💛", actor: "agent" } as const;
    const updated = attachMessageReaction(messages, "msg-queued-123", reaction);
    expect(updated[1]).toMatchObject({ reaction });
    expect(updated[0]).toBe(messages[0]);
    expect(updated[3]).toBe(messages[3]);
    expect(attachMessageReaction(updated, "msg-queued-123", reaction)).toBe(updated);
    expect(attachMessageReaction(messages, "answer", reaction)).toBe(messages);
    expect(attachMessageReaction(messages, "missing", reaction)).toBe(messages);
    render(<AgentMessageReactionBadge reaction={reaction} />);
    expect(screen.getByRole("img", { name: "Agent One reacted with yellow heart" }))
      .not.toHaveAttribute("tabindex");
  });
});

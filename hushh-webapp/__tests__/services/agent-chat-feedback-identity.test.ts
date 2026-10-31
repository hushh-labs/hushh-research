import { describe, expect, it } from "vitest";

import { lastAssistantMessageId } from "@/lib/services/agent-chat-client";

// A live reply is created under a browser id before the server has one. The
// run's closing snapshot carries the ADK event ids; the last assistant message
// with content is this turn's answer, and ratings key on it so a thumbs given
// during the turn matches the same reply after a reload.
describe("lastAssistantMessageId", () => {
  it("takes the last assistant message that has content", () => {
    expect(
      lastAssistantMessageId([
        { id: "u1", role: "user", content: "hi" },
        { id: "evt-tool", role: "assistant", content: "" },
        { id: "evt-1", role: "assistant", content: "First part" },
        { id: "tool-1", role: "tool", content: "{}" },
        { id: "evt-2", role: "assistant", content: "The answer" },
      ]),
    ).toBe("evt-2");
  });

  it("skips assistant entries with no content (tool-call carriers)", () => {
    expect(
      lastAssistantMessageId([
        { id: "evt-1", role: "assistant", content: "Answer" },
        { id: "evt-2", role: "assistant", content: "  " },
      ]),
    ).toBe("evt-1");
  });

  it("returns null when there is nothing to key on", () => {
    expect(lastAssistantMessageId(undefined)).toBeNull();
    expect(lastAssistantMessageId([])).toBeNull();
    expect(lastAssistantMessageId([{ id: "u1", role: "user", content: "hi" }])).toBeNull();
    expect(lastAssistantMessageId([{ role: "assistant", content: "no id" }])).toBeNull();
  });
});
